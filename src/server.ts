import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { NoSchemaIntrospectionCustomRule } from "graphql";
import { createYoga, type Plugin } from "graphql-yoga";
import type { Container } from "./container";
import { createContext, type RequestContext } from "./graphql/context";
import { depthLimit } from "./graphql/limits";
import { buildSchema } from "./graphql/schema";

type ServerContext = { req: FastifyRequest; reply: FastifyReply };

/** Validation rules on every operation: depth limit, and no introspection unless enabled. */
function rules(introspection: boolean): Plugin {
  return {
    onValidate({ addValidationRule }) {
      addValidationRule(depthLimit(12));
      if (!introspection) addValidationRule(NoSchemaIntrospectionCustomRule);
    },
  };
}

/**
 * The HTTP server: ONE GraphQL endpoint (Yoga on Fastify) for everything, plus GET /health for load
 * balancers. No other routes: PDFs and CSVs travel inside GraphQL responses.
 */
export async function buildServer(container: Container): Promise<FastifyInstance> {
  const { config } = container;
  const app = Fastify({ logger: config.env === "production" ? { level: "info" } : config.env === "test" ? false : { level: "warn" }, bodyLimit: config.bodyLimit, trustProxy: config.trustProxy });

  const yoga = createYoga<ServerContext, RequestContext>({
    schema: buildSchema(),
    graphqlEndpoint: config.graphqlPath,
    graphiql: config.graphiql ? { title: "MGPL Diagnostics API" } : false,
    landingPage: false,
    // domain errors carry their own codes (src/graphql/errors.ts); everything else becomes "Unexpected error"
    maskedErrors: true,
    cors: { origin: config.corsOrigins.includes("*") ? "*" : config.corsOrigins, methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["content-type", "authorization"] },
    logging: config.env === "test" ? false : "warn",
    plugins: [rules(config.introspection)],
    context: ({ request, req }) => createContext(container, { headers: request.headers, ip: req.ip }),
  });

  app.route({
    url: config.graphqlPath,
    method: ["GET", "POST", "OPTIONS"],
    handler: async (req, reply) => {
      const response = await yoga.handleNodeRequestAndResponse(req, reply, { req, reply });
      response.headers.forEach((value, key) => void reply.header(key, value));
      reply.status(response.status);
      reply.send(response.body);
      return reply;
    },
  });

  app.get("/health", async (_req, reply) => {
    try {
      await container.db.rawRepos.orgs.count();
      return { ok: true };
    } catch {
      return reply.status(503).send({ ok: false });
    }
  });

  app.addHook("onClose", async () => container.close());
  return app;
}
