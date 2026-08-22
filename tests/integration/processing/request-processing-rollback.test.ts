/**
 * Integration test: services/processing/request-processing.server.ts's
 * `createAndEnqueueProcessingJob` rollback boundary — same gap/fix as
 * tests/integration/generation/request-generation-rollback.test.ts,
 * applied to the processing domain. `services/processing/queue.server.ts`
 * is mocked (its `enqueueProcessingJob` throws); everything else is real
 * Postgres.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import prisma from "../../../db/client.server";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import type { SyncedProduct } from "../../../services/products/types";
import type { AuthContext } from "../../../lib/auth/types";

vi.mock("../../../services/processing/queue.server", () => ({
  enqueueProcessingJob: vi.fn(async () => {
    throw new Error("simulated Redis failure");
  }),
}));

const SHOP = "proc-rollback-test.myshopify.com";
const CONTEXT: AuthContext = { shop: SHOP, sessionId: "s1", isOnline: false };

function product(shopifyProductId: string): SyncedProduct {
  return {
    shopifyProductId,
    title: "Studio Mug",
    handle: "studio-mug",
    description: "A ceramic mug.",
    productType: "Kitchen",
    category: null,
    vendor: "Acme",
    tags: [],
    status: "ACTIVE",
    shopifyCreatedAt: new Date(),
    shopifyUpdatedAt: new Date(),
    media: [
      {
        shopifyMediaId: "gid://shopify/MediaImage/proc-rollback-1",
        mediaType: "IMAGE",
        originalUrl: "https://cdn.shopify.com/mug.jpg",
        previewUrl: null,
        width: 800,
        height: 600,
        altText: "Studio mug",
        position: 0,
      },
    ],
  };
}

async function cleanup() {
  await prisma.creditReservation.deleteMany({ where: { shop: SHOP } });
  await prisma.processingJob.deleteMany({ where: { shop: SHOP } });
  await prisma.shopifyProduct.deleteMany({ where: { shop: SHOP } });
}

let requestProcessing: typeof import("../../../services/processing/request-processing.server").requestProcessing;

beforeAll(async () => {
  resetEnvCacheForTests();
  ({ requestProcessing } = await import("../../../services/processing/request-processing.server"));
  await cleanup();
});

afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("createAndEnqueueProcessingJob — rollback on enqueue failure", () => {
  it(
    "refunds the credit reservation and marks the job FAILED when enqueueing fails after reservation",
    async () => {
      await upsertSyncedProduct(SHOP, product("gid://shopify/Product/proc-rollback-1"));
      const row = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP, shopifyProductId: "gid://shopify/Product/proc-rollback-1" } });
      const media = await prisma.shopifyProductMedia.findFirstOrThrow({ where: { productId: row.id } });

      await expect(
        requestProcessing(CONTEXT, { productId: row.id, sourceMediaId: media.id, operation: "REMOVE_BACKGROUND" }),
      ).rejects.toThrow("simulated Redis failure");

      const jobRow = await prisma.processingJob.findFirstOrThrow({ where: { shop: SHOP, productId: row.id } });
      expect(jobRow.status).toBe("FAILED");

      const reservation = await prisma.creditReservation.findUniqueOrThrow({ where: { jobId: jobRow.id } });
      expect(reservation.status).toBe("REFUNDED");
    },
    15000,
  );
});
