/**
 * Repository for `CreativeSession` — see db/repositories/README.md and
 * prisma/schema.prisma. Every function that loads a session by a
 * client-supplied id takes the caller's `AuthContext` and verifies shop
 * ownership before returning it — see CLAUDE.md "Security requirements".
 */
import type { CreativeSessionStatus, CreativeSourceType, Prisma } from "@prisma/client";
import prisma from "../client.server";
import type { AuthContext } from "../../lib/auth/types";
import { assertShopOwnership } from "../../lib/auth/tenant.server";

const SESSION_SELECT = {
  id: true,
  shop: true,
  productId: true,
  sourceType: true,
  sourceResultId: true,
  sourceMediaId: true,
  currentResultId: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  product: { select: { id: true, title: true } },
} satisfies Prisma.CreativeSessionSelect;

export type CreativeSessionRow = Prisma.CreativeSessionGetPayload<{ select: typeof SESSION_SELECT }>;

export interface CreateCreativeSessionInput {
  shop: string;
  /** Null for a standalone (no Shopify product) session — see this
   * model's schema comment. */
  productId: string | null;
  sourceType: CreativeSourceType;
  sourceResultId?: string | null;
  sourceMediaId?: string | null;
}

export async function createCreativeSession(input: CreateCreativeSessionInput): Promise<{ id: string }> {
  return prisma.creativeSession.create({
    data: {
      shop: input.shop,
      productId: input.productId,
      sourceType: input.sourceType,
      sourceResultId: input.sourceResultId ?? null,
      sourceMediaId: input.sourceMediaId ?? null,
    },
    select: { id: true },
  });
}

/** Loads one Creative Session, verifying shop ownership. Returns `null`
 * if not found for this shop — the same safe "existence oracle" 404
 * shape every other domain in this codebase uses. */
export async function getCreativeSession(context: AuthContext, id: string): Promise<CreativeSessionRow | null> {
  const row = await prisma.creativeSession.findUnique({ where: { id }, select: SESSION_SELECT });
  if (!row) return null;
  assertShopOwnership(context, row.shop);
  return row;
}

/** Updates the session's "current working result" pointer — called every
 * time a new result becomes the canvas' current selection (a fresh
 * generation succeeding, or the merchant explicitly picking a different
 * variation). Silently a no-op if `id` doesn't belong to `shop` (defense
 * in depth — every real caller already verified ownership via
 * `getCreativeSession` first). */
export async function setCurrentResult(shop: string, id: string, currentResultId: string): Promise<void> {
  await prisma.creativeSession.updateMany({ where: { id, shop }, data: { currentResultId } });
}

export async function setCreativeSessionStatus(context: AuthContext, id: string, status: CreativeSessionStatus): Promise<boolean> {
  const existing = await prisma.creativeSession.findUnique({ where: { id }, select: { shop: true } });
  if (!existing || existing.shop !== context.shop) return false;
  await prisma.creativeSession.update({ where: { id }, data: { status } });
  return true;
}

/** Most-recent-first sessions for one product — surfaced on the product
 * detail page ("Continue a Creative Studio session" / "Create with AI"
 * entry point). Scoped directly by `[shop, productId]`, so no separate
 * ownership check is needed. */
export async function listCreativeSessionsForProduct(context: AuthContext, productId: string): Promise<CreativeSessionRow[]> {
  return prisma.creativeSession.findMany({
    where: { shop: context.shop, productId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: SESSION_SELECT,
  });
}

/** Most-recently-active-first sessions for the WHOLE shop — the standalone
 * workspace's "conversation history" (sidebar) and "creations" (gallery)
 * views, where a session isn't scoped to any one product (most have
 * `productId: null`; see prisma/schema.prisma's CreativeSession.productId
 * comment). Ordered by `updatedAt` (not `createdAt`) so a conversation
 * that just received a new message/result rises back to the top, the
 * same "most recently active" ordering a chat product's sidebar always
 * uses. `limit` bounds the fetch — a workspace's own conversation list is
 * inherently small, but this is still a real cap, not a raw unbounded
 * scan, mirroring every other "list for shop" function in this codebase
 * (e.g. generation-job.repository.ts's `listGenerationResultsForShop`). */
export async function listCreativeSessionsForShop(context: AuthContext, limit: number): Promise<CreativeSessionRow[]> {
  return prisma.creativeSession.findMany({
    where: { shop: context.shop },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: limit,
    select: SESSION_SELECT,
  });
}

export type { CreativeSessionStatus, CreativeSourceType };
