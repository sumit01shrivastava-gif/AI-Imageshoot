/**
 * Integration test: services/generation/request-generation.server.ts's
 * `createAndEnqueueGenerationJob` rollback boundary — a genuine
 * correctness gap found during the final production-integration audit
 * (Part 3): if credit reservation succeeds but something AFTER it fails
 * (here, simulated by making the queue enqueue call itself throw — a
 * stand-in for "Redis briefly unreachable"), the job would otherwise
 * never be picked up by a worker, leaving its `CreditReservation` stuck
 * RESERVED forever with no future event to resolve it.
 *
 * `services/generation/queue.server.ts` is mocked (its `enqueueGenerationJob`
 * throws) — everything else (Postgres, the real service/repository
 * functions) is real, so this proves the rollback against real database
 * state, not a fully-mocked unit.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import prisma from "../../../db/client.server";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import { saveResult as saveIntelligenceResult } from "../../../db/repositories/product-intelligence.repository";
import { parseProductIntelligenceOutput } from "../../../services/intelligence/schema";
import type { SyncedProduct } from "../../../services/products/types";
import type { AuthContext } from "../../../lib/auth/types";

vi.mock("../../../services/generation/queue.server", () => ({
  enqueueGenerationJob: vi.fn(async () => {
    throw new Error("simulated Redis failure");
  }),
}));

const SHOP = "gen-rollback-test.myshopify.com";
const CONTEXT: AuthContext = { shop: SHOP, sessionId: "s1", isOnline: false };

function product(shopifyProductId: string): SyncedProduct {
  return {
    shopifyProductId,
    title: "Studio Lamp",
    handle: "studio-lamp",
    description: "A minimalist lamp.",
    productType: "Home",
    category: "Home & Garden > Lighting",
    vendor: "Acme Home",
    tags: ["lamp"],
    status: "ACTIVE",
    shopifyCreatedAt: new Date(),
    shopifyUpdatedAt: new Date("2026-01-05T00:00:00Z"),
    media: [
      {
        shopifyMediaId: "gid://shopify/MediaImage/rollback-1",
        mediaType: "IMAGE",
        originalUrl: "https://cdn.shopify.com/lamp.jpg",
        previewUrl: null,
        width: 800,
        height: 600,
        altText: "Studio lamp",
        position: 0,
      },
    ],
  };
}

async function cleanup() {
  await prisma.creditReservation.deleteMany({ where: { shop: SHOP } });
  await prisma.generationJob.deleteMany({ where: { shop: SHOP } });
  await prisma.shopifyProduct.deleteMany({ where: { shop: SHOP } });
}

let requestGeneration: typeof import("../../../services/generation/request-generation.server").requestGeneration;

beforeAll(async () => {
  process.env.AI_PROVIDER = "deterministic-test";
  resetEnvCacheForTests();
  ({ requestGeneration } = await import("../../../services/generation/request-generation.server"));
  await cleanup();
});

afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
  delete process.env.AI_PROVIDER;
});

async function seedAnalyzedProduct(shopifyProductId: string) {
  await upsertSyncedProduct(SHOP, product(shopifyProductId));
  const row = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP, shopifyProductId } });
  const parsed = parseProductIntelligenceOutput({
    category: "Home & Garden > Lighting",
    subcategory: null,
    material: "Ceramic",
    primaryColor: "White",
    secondaryColors: [],
    pattern: null,
    texture: null,
    style: null,
    useCases: [],
    targetAudience: null,
    genderSuitability: null,
    seasonality: [],
    pricePositioning: null,
    visualCharacteristics: null,
    productDimensions: null,
    packagingCharacteristics: null,
    hardwareComponents: [],
    modelSuitable: false,
    recommendedModelAttributes: null,
    recommendedPoseTypes: [],
    recommendedEnvironments: ["studio"],
    recommendedProps: [],
    recommendedPhotographyStyles: [],
    recommendedAssetTypes: ["product_studio"],
    identityAnchors: {
      category: "Home & Garden > Lighting",
      shape: "Cylindrical",
      material: "Ceramic",
      primaryColor: "White",
      constructionDetails: [],
      distinctiveHardware: [],
      brandingVisible: false,
      brandingDescription: null,
    },
  });
  await saveIntelligenceResult(SHOP, row.id, parsed, {
    providerName: "deterministic-test",
    sourceShopifyUpdatedAt: row.shopifyUpdatedAt,
    rawAnalysis: {},
  });
  return row;
}

describe("createAndEnqueueGenerationJob — rollback on enqueue failure", () => {
  it(
    "refunds the credit reservation and marks the job FAILED when enqueueing fails after reservation, instead of leaving it stuck RESERVED forever",
    async () => {
      const row = await seedAnalyzedProduct("gid://shopify/Product/rollback-1");

      await expect(requestGeneration(CONTEXT, { productId: row.id, generationType: "PRODUCT_CLEANUP" })).rejects.toThrow(
        "simulated Redis failure",
      );

      const jobRow = await prisma.generationJob.findFirstOrThrow({ where: { shop: SHOP, productId: row.id } });
      expect(jobRow.status).toBe("FAILED");

      const reservation = await prisma.creditReservation.findUniqueOrThrow({ where: { jobId: jobRow.id } });
      expect(reservation.status).toBe("REFUNDED");
    },
    15000,
  );
});
