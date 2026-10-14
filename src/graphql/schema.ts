import { makeExecutableSchema } from "@graphql-tools/schema";
import type { GraphQLSchema } from "graphql";
import { authController } from "../controllers/auth.controller";
import { baseController } from "../controllers/base.controller";
import { billingController } from "../controllers/billing.controller";
import { booksController } from "../controllers/books.controller";
import { catalogController } from "../controllers/catalog.controller";
import { documentsController } from "../controllers/documents.controller";
import { financeController } from "../controllers/finance.controller";
import { labController } from "../controllers/lab.controller";
import { organizationController } from "../controllers/organization.controller";
import { authTypeDefs } from "../schema/auth.graphql";
import { baseTypeDefs } from "../schema/base.graphql";
import { billingTypeDefs } from "../schema/billing.graphql";
import { booksTypeDefs } from "../schema/books.graphql";
import { catalogTypeDefs } from "../schema/catalog.graphql";
import { documentsTypeDefs } from "../schema/documents.graphql";
import { financeTypeDefs } from "../schema/finance.graphql";
import { labTypeDefs } from "../schema/lab.graphql";
import { organizationTypeDefs } from "../schema/organization.graphql";

/** One domain = one SDL file in src/schema + one controller in src/controllers. */
export interface GraphQLModule {
  name: string;
  typeDefs: string;
  resolvers: Record<string, unknown>;
}

export const MODULES: GraphQLModule[] = [
  { name: "base", typeDefs: baseTypeDefs, resolvers: baseController },
  { name: "auth", typeDefs: authTypeDefs, resolvers: authController },
  { name: "organization", typeDefs: organizationTypeDefs, resolvers: organizationController },
  { name: "catalog", typeDefs: catalogTypeDefs, resolvers: catalogController },
  { name: "lab", typeDefs: labTypeDefs, resolvers: labController },
  { name: "billing", typeDefs: billingTypeDefs, resolvers: billingController },
  { name: "books", typeDefs: booksTypeDefs, resolvers: booksController },
  { name: "finance", typeDefs: financeTypeDefs, resolvers: financeController },
  { name: "documents", typeDefs: documentsTypeDefs, resolvers: documentsController },
];

/** The whole API as one executable schema. */
export function buildSchema(modules: GraphQLModule[] = MODULES): GraphQLSchema {
  return makeExecutableSchema({ typeDefs: modules.map((m) => m.typeDefs), resolvers: modules.map((m) => m.resolvers) as never });
}
