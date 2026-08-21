/**
 * Repository for `CreativeMessage` — one row per conversation turn under
 * a `CreativeSession`. See db/repositories/README.md and
 * prisma/schema.prisma.
 *
 * Every function is scoped directly by `[shop, creativeSessionId]`
 * (create/list below) — the caller (services/creative-studio/session.server.ts)
 * always loads the owning `CreativeSession` via
 * `getCreativeSession`/`assertShopOwnership` first, so a separate
 * ownership check per message isn't needed here, mirroring
 * db/repositories/generation-job.repository.ts's `listGenerationJobsForBatch`
 * reasoning.
 */
import type { CreativeMessageRole, Prisma } from "@prisma/client";
import prisma from "../client.server";

const MESSAGE_SELECT = {
  id: true,
  role: true,
  content: true,
  intent: true,
  generationJobId: true,
  createdAt: true,
} satisfies Prisma.CreativeMessageSelect;

export type CreativeMessageRow = Prisma.CreativeMessageGetPayload<{ select: typeof MESSAGE_SELECT }>;

export interface CreateCreativeMessageInput {
  shop: string;
  creativeSessionId: string;
  role: CreativeMessageRole;
  content: string;
  intent?: Record<string, unknown> | null;
  generationJobId?: string | null;
}

export async function createCreativeMessage(input: CreateCreativeMessageInput): Promise<CreativeMessageRow> {
  return prisma.creativeMessage.create({
    data: {
      shop: input.shop,
      creativeSessionId: input.creativeSessionId,
      role: input.role,
      content: input.content,
      intent: (input.intent ?? undefined) as Prisma.InputJsonValue | undefined,
      generationJobId: input.generationJobId ?? null,
    },
    select: MESSAGE_SELECT,
  });
}

/** Oldest-first — the natural reading order for a chat transcript. */
export async function listCreativeMessages(shop: string, creativeSessionId: string): Promise<CreativeMessageRow[]> {
  return prisma.creativeMessage.findMany({
    where: { shop, creativeSessionId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: MESSAGE_SELECT,
  });
}

export type { CreativeMessageRole };
