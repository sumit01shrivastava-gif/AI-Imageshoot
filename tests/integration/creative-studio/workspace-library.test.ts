/**
 * Integration test: services/creative-studio/workspace-library.server.ts's
 * `listWorkspaceConversations` — the standalone studio's sidebar/
 * Creations-gallery read composition. Builds fixtures directly through
 * the existing repositories (no real queue/worker needed here — that
 * path is covered end-to-end by tests/integration/routes/studio-routes.test.ts)
 * so these stay fast while still exercising real Postgres reads, not
 * mocks.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../../db/client.server";
import type { AuthContext } from "../../../lib/auth/types";
import { createCreativeSession, setCurrentResult } from "../../../db/repositories/creative-session.repository";
import { createCreativeMessage } from "../../../db/repositories/creative-message.repository";
import { createGenerationJob, createResults } from "../../../db/repositories/generation-job.repository";
import { listWorkspaceConversations } from "../../../services/creative-studio/workspace-library.server";
import type { GenerationPlan } from "../../../services/generation/schema";

const SHOP = "workspace-library-test-workspace";
const OTHER_SHOP = "workspace-library-other-workspace";
const CONTEXT: AuthContext = { shop: SHOP, sessionId: "s1", isOnline: true };

function minimalStandalonePlan(): GenerationPlan {
  return {
    generationType: "CREATIVE_STUDIO",
    assetType: null,
    category: "product",
    sourceProductId: null,
    sourceImages: [],
    productFacts: { identityAnchors: null, title: null, description: null, attributes: null },
    creativeDirection: { prompt: "A clean product photo.", negativeConstraints: [], environment: null, lighting: null, composition: null },
    aspectRatio: "1:1",
    outputFormat: "png",
    quality: "standard",
    outputCount: 1,
    maxResolutionPx: null,
    modelConfiguration: null,
    brandStyle: null,
    lifestyleScene: null,
    creativeIntent: null,
    referenceImages: [],
    constraints: [],
  };
}

async function cleanup() {
  for (const shop of [SHOP, OTHER_SHOP]) {
    await prisma.creativeMessage.deleteMany({ where: { shop } });
    await prisma.generationResult.deleteMany({ where: { shop } });
    await prisma.generationJob.deleteMany({ where: { shop } });
    await prisma.creativeSession.deleteMany({ where: { shop } });
  }
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("listWorkspaceConversations", () => {
  it("returns \"New conversation\" for a session with no messages yet", async () => {
    const session = await createCreativeSession({ shop: SHOP, productId: null, sourceType: "PRODUCT_IMAGE" });
    const [summary] = await listWorkspaceConversations(CONTEXT, { limit: 10 });
    expect(summary.id).toBe(session.id);
    expect(summary.title).toBe("New conversation");
    expect(summary.versionCount).toBe(0);
    expect(summary.thumbnailUrl).toBeNull();
    expect(summary.latestJobStatus).toBeNull();
  });

  it("derives the title from the first USER message, truncated for a long message", async () => {
    const session = await createCreativeSession({ shop: SHOP, productId: null, sourceType: "PRODUCT_IMAGE" });
    const longMessage = "Create a premium campaign image for a luxury skincare brand's new website hero banner section please";
    await createCreativeMessage({ shop: SHOP, creativeSessionId: session.id, role: "USER", content: longMessage });
    await createCreativeMessage({ shop: SHOP, creativeSessionId: session.id, role: "ASSISTANT", content: "Creating your image…" });

    const [summary] = await listWorkspaceConversations(CONTEXT, { limit: 10 });
    expect(summary.title.length).toBeLessThanOrEqual(65);
    expect(summary.title.startsWith("Create a premium campaign image")).toBe(true);
    expect(summary.title.endsWith("…")).toBe(true);
  });

  it("reports a real thumbnail URL and version count once a job has produced results, only when withThumbnails is true", async () => {
    const session = await createCreativeSession({ shop: SHOP, productId: null, sourceType: "PRODUCT_IMAGE" });
    await createCreativeMessage({ shop: SHOP, creativeSessionId: session.id, role: "USER", content: "Create a clean product photo" });

    const job = await createGenerationJob({
      shop: SHOP,
      productId: null,
      type: "CREATIVE_STUDIO",
      sourceMediaIds: [],
      plan: minimalStandalonePlan(),
      creativeSessionId: session.id,
    });
    await createResults(SHOP, job.id, [
      {
        storageKey: `shops/${SHOP}/generations/${job.id}/0.png`,
        url: null,
        width: 1024,
        height: 1024,
        format: "png",
        providerName: "deterministic-test",
        providerResultId: null,
        metadata: null,
      },
    ]);
    const [result] = await prisma.generationResult.findMany({ where: { generationJobId: job.id } });
    await setCurrentResult(SHOP, session.id, result.id);

    const [withThumb] = await listWorkspaceConversations(CONTEXT, { limit: 10, withThumbnails: true });
    expect(withThumb.thumbnailUrl).toBeTruthy();
    expect(withThumb.versionCount).toBe(1);
    expect(withThumb.latestJobId).toBe(job.id);

    const [withoutThumb] = await listWorkspaceConversations(CONTEXT, { limit: 10, withThumbnails: false });
    expect(withoutThumb.thumbnailUrl).toBeNull();
    expect(withoutThumb.versionCount).toBe(1);
  });

  it("never lists another workspace's conversations", async () => {
    await createCreativeSession({ shop: OTHER_SHOP, productId: null, sourceType: "PRODUCT_IMAGE" });
    const summaries = await listWorkspaceConversations(CONTEXT, { limit: 10 });
    expect(summaries).toEqual([]);
  });

  it("orders most-recently-updated first", async () => {
    const older = await createCreativeSession({ shop: SHOP, productId: null, sourceType: "PRODUCT_IMAGE" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await createCreativeSession({ shop: SHOP, productId: null, sourceType: "PRODUCT_IMAGE" });

    const summaries = await listWorkspaceConversations(CONTEXT, { limit: 10 });
    expect(summaries[0].id).toBe(newer.id);
    expect(summaries[1].id).toBe(older.id);
  });
});
