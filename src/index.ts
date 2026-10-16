// The api as a library (tests, scripts, other entry points): build a container and a server.
export { loadConfig, type Config } from "./config/env";
export { createContainer, type Container, type ContainerOptions } from "./container";
export { buildServer } from "./server";
export { isDraining, shutdown, shutdownOnSignals, type ShutdownOptions } from "./lifecycle";
export { buildSchema, MODULES, type GraphQLModule } from "./graphql/schema";
export { ERROR_CODES, type ErrorCode } from "./graphql/errors";
export type { RequestContext, Actor } from "./graphql/context";
export type { Mailer } from "./services/auth.service";
export { createBullJobQueue, createInlineJobQueue, startWorkers, webhookMailer, mailKitMailer, mailerFromConfig, type JobDeps, type JobInfo, type JobQueue } from "./jobs";
