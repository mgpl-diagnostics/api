import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { NoSchemaIntrospectionCustomRule } from "graphql";
import { createYoga, type Plugin } from "graphql-yoga";
import { API_CSP, fastifySecurity, type RequestSecurity } from "@mgpl-diagnostics/security-kit/server";
import type { Container } from "./container";
import { createContext, type RequestContext } from "./graphql/context";
import { depthLimit } from "./graphql/limits";
import { buildSchema } from "./graphql/schema";

type ServerContext = { req: FastifyRequest; reply: FastifyReply };

/** What fastifySecurity put on the request (falls back to the socket address). */
const securityOf = (req: FastifyRequest): Pick<RequestSecurity, "ip" | "tlsFingerprint"> =>
  (req as FastifyRequest & { security?: RequestSecurity | null }).security ?? { ip: req.ip, tlsFingerprint: null };

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
  const app = Fastify({ logger: config.env === "production" ? { level: "info" } : config.env === "test" ? false : { level: "warn" }, bodyLimit: config.bodyLimit, trustProxy: (_addr: string, hop: number) => hop < config.trustedHops });

  // security-kit: security headers on every response, and request.security = { ip, userAgent, … } with the
  // client IP taken from X-Forwarded-For only through the configured number of proxies (TRUST_PROXY).
  // With TLS_FINGERPRINT_HEADER, request.security.tlsFingerprint is the JA4/JA3 the TLS-terminating proxy
  // sent (only through those trusted proxies). CORS stays with Yoga below. GraphiQL (development) loads scripts, so it gets no CSP.
  await app.register(
    fastifySecurity({
      headers: { hsts: config.env === "production" ? 31_536_000 : false, csp: config.graphiql ? false : API_CSP },
      trustedHops: config.trustedHops,
      tlsFingerprintHeader: config.tlsFingerprintHeader ?? undefined,
    }),
  );

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
    context: ({ request, req }) => {
      const sec = securityOf(req);
      return createContext(container, { headers: request.headers, ip: sec.ip ?? undefined, tlsFingerprint: sec.tlsFingerprint?.value });
    },
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
