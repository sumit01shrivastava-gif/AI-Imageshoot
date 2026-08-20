// Thin re-export — the real Prisma client lives in db/client.server.ts.
// Kept at this path so React Router route modules can use the conventional
// relative `../db.server` import.
export { default } from "../db/client.server";
