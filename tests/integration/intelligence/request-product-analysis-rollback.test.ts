/**
 * Integration test: services/intelligence/product-intelligence.server.ts's
 * `requestProductAnalysis` rollback boundary — same gap/fix as
 * tests/integration/generation/request-generation-rollback.test.ts,
 * applied to the intelligence domain. Unlike the other three domains,
 * this one has no dedicated job row to mark FAILED — the reservation is a
 * synthetic per-request id (see product-intelligence.server.ts's doc
 * comment on the queue's collapsed-duplicate-in-flight semantics), and the
 * "job" state lives on `ProductIntelligence.status` instead.
 * `services/intelligence/queue.server.ts` is mocked (its
 * `enqueueProductIntelligenceAnalysis` throws); everything else is real
 * Postgres.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import prisma from "../../../db/client.server";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import type { SyncedProduct } from "../../../services/products/types";
import type { AuthContext } from "../../../lib/auth/types";

vi.mock("../../../services/intelligence/queue.server", () => ({
  enqueueProductIntelligenceAnalysis: vi.fn(async () => {
    throw new Error("simulated Redis failure");
  }),
}));

const SHOP = "intel-rollback-test.myshopify.com";
const CONTEXT: AuthContext = { shop: SHOP, sessionId: "s1", isOnline: false };

function product(shopifyProductId: string): SyncedProduct {
  return {
    shopifyProductId,
    title: "Studio Sofa",
    handle: "studio-sofa",
    description: "A minimalist sofa.",
    productType: "Furniture",
    category: "Home & Garden > Furniture",
    vendor: "Acme Home",
    tags: ["sofa"],
    status: "ACTIVE",
    shopifyCreatedAt: new Date(),
    shopifyUpdatedAt: new Date("2026-01-05T00:00:00Z"),
    media: [
      {
        shopifyMediaId: "gid://shopify/MediaImage/intel-rollback-1",
        mediaType: "IMAGE",
        originalUrl: "https://cdn.shopify.com/sofa.jpg",
        previewUrl: null,
        width: 800,
        height: 600,
        altText: "Studio sofa",
        position: 0,
      },
    ],
  };
}

async function cleanup() {
  await prisma.shopifyProduct.deleteMany({ where: { shop: SHOP } });
  await prisma.creditReservation.deleteMany({ where: { shop: SHOP } });
}

let requestProductAnalysis: typeof import("../../../services/intelligence/product-intelligence.server").requestProductAnalysis;

beforeAll(async () => {
  resetEnvCacheForTests();
  ({ requestProductAnalysis } = await import("../../../services/intelligence/product-intelligence.server"));
  await cleanup();
});

afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("requestProductAnalysis — rollback on enqueue failure", () => {
  it(
    "refunds the synthetic credit reservation and marks the profile FAILED when enqueueing fails after reservation",
    async () => {
      await upsertSyncedProduct(SHOP, product("gid://shopify/Product/intel-rollback-1"));
      const row = await prisma.shopifyProduct.findFirstOrThrow({
        where: { shop: SHOP, shopifyProductId: "gid://shopify/Product/intel-rollback-1" },
      });

      await expect(requestProductAnalysis(CONTEXT, row.id)).rejects.toThrow("simulated Redis failure");

      const profile = await prisma.productIntelligence.findFirstOrThrow({ where: { shop: SHOP, productId: row.id } });
      expect(profile.status).toBe("FAILED");

      const reservation = await prisma.creditReservation.findFirstOrThrow({ where: { shop: SHOP } });
      expect(reservation.status).toBe("REFUNDED");
    },
    15000,
  );
});
