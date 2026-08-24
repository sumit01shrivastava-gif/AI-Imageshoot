/**
 * Workspace repository — standalone (non-Shopify) tenant. See
 * prisma/schema.prisma's "Standalone identity / workspace foundation"
 * section for why `Workspace.tenantKey` is what ends up in
 * `AuthContext.shop` for standalone requests.
 */
import { randomUUID } from "node:crypto";
import prisma from "../client.server";
import type { Workspace } from "@prisma/client";

/** Never a real Shopify domain — a `workspace:` prefix keeps this
 * visually distinguishable from a shop domain wherever it might show up
 * in logs, purely for human readability (nothing parses this format). */
function generateTenantKey(): string {
  return `workspace:${randomUUID()}`;
}

export async function createWorkspaceForUser(userId: string, name: string): Promise<Workspace> {
  return prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({
      data: { name, tenantKey: generateTenantKey() },
    });
    await tx.workspaceMembership.create({
      data: { userId, workspaceId: workspace.id, role: "owner" },
    });
    return workspace;
  });
}

export async function getDefaultWorkspaceForUser(userId: string): Promise<Workspace | null> {
  const membership = await prisma.workspaceMembership.findFirst({
    where: { userId },
    orderBy: { createdAt: "asc" },
    include: { workspace: true },
  });
  return membership?.workspace ?? null;
}
