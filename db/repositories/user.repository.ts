/**
 * User repository — standalone (non-Shopify) identity only. Not
 * shop-scoped (a User doesn't belong to a shop; a Workspace does — see
 * workspace.repository.ts) so this deliberately doesn't follow the
 * `assertShopOwnership` pattern every other repository in this codebase
 * uses; lookups here are always by the user's own id/email, resolved from
 * an already-verified session (lib/auth/standalone-session.server.ts),
 * never from a client-supplied id.
 */
import prisma from "../client.server";
import type { User } from "@prisma/client";

export async function findUserByEmail(email: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
}

export async function findUserById(id: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { id } });
}

export async function createUser(email: string, passwordHash: string): Promise<User> {
  return prisma.user.create({
    data: { email: email.toLowerCase().trim(), passwordHash },
  });
}
