/**
 * Prisma client singleton.
 *
 * Canonical location for the database connection — everything that needs
 * Prisma (session storage, and every future repository under
 * db/repositories/) imports from here. `app/db.server.ts` re-exports this
 * unchanged so existing React Router route conventions (relative
 * `../db.server` imports) keep working.
 *
 * The `global` caching avoids exhausting Postgres connections from Vite's
 * dev-server module reloads creating a fresh PrismaClient on every edit.
 */
import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient | undefined;
}

const prisma = global.prismaGlobal ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  global.prismaGlobal = prisma;
}

export default prisma;
