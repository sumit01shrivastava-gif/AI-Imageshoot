/**
 * Regression test for the "stored GenerationResult.url expires after an
 * hour and is never re-signed on read" bug (see
 * lib/storage/resign.server.ts's doc comment and
 * services/generation/request-generation.server.ts's `getGeneration`/
 * `listGenerationHistory`, which now call it). Against a real local
 * Postgres and the real `LocalFilesystemStorageProvider` — no mocking —
 * so this proves the actual signature the merchant's browser would
 * receive is valid, not just that some function was called.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../../db/client.server";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import { createGenerationJob, createResults } from "../../../db/repositories/generation-job.repository";
import { getGeneration, listGenerationHistory } from "../../../services/generation/request-generation.server";
import { parseGenerationPlan } from "../../../services/generation/schema";
import { verifyMediaUrlSignature, resetConfiguredStorageProviderForTests } from "../../../lib/storage";
import type { AuthContext } from "../../../lib/auth/types";
import type { SyncedProduct } from "../../../services/products/types";

const SHOP = "gen-url-resign-test.myshopify.com";
const CONTEXT: AuthContext = { shop: SHOP, sessionId: "s1", isOnline: false };

function product(shopifyProductId: string): SyncedProduct {
  return {
    shopifyProductId,
    title: "Red Leather Handbag",
    handle: "red-leather-handbag",
    description: "",
    productType: "Handbags",
    category: null,
    vendor: "",
    tags: [],
    status: "ACTIVE",
    shopifyCreatedAt: new Date(),
    shopifyUpdatedAt: new Date("2026-01-01T00:00:00Z"),
    media: [],
  };
}

function plan() {
  return parseGenerationPlan({
    generationType: "PRODUCT_CLEANUP",
    assetType: "product_studio",
    category: "Handbags",
    sourceProductId: "product-1",
    sourceImages: [{ mediaId: "media-1", url: "https://cdn/1.jpg", altText: "Front", position: 0 }],
    productFacts: { identityAnchors: null },
    creativeDirection: {
      prompt: "Clean product photography of the red leather handbag.",
      negativeConstraints: [],
      environment: null,
      lighting: null,
      composition: null,
    },
    aspectRatio: "1:1",
    outputFormat: "png",
    quality: "standard",
    outputCount: 1,
    modelConfiguration: null,
    brandStyle: null,
    lifestyleScene: null,
    constraints: [],
  });
}

async function cleanup() {
  await prisma.shopifyProduct.deleteMany({ where: { shop: SHOP } });
  await prisma.generationJob.deleteMany({ where: { shop: SHOP } });
}

beforeAll(cleanup);
afterEach(async () => {
  await cleanup();
  resetConfiguredStorageProviderForTests();
});
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

/** Builds the exact "stale" URL shape LocalFilesystemStorageProvider
 * would have produced an hour+ ago — `expires` already in the past, and
 * a signature that (being for that past expiry) would fail verification
 * even if it happened to be otherwise well-formed. */
function staleUrl(storageKey: string): string {
  const expiredAt = Date.now() - 60_000;
  return `/media/${storageKey}?expires=${expiredAt}&sig=0000000000000000000000000000000000000000000000000000000000000000`;
}

describe("getGeneration / listGenerationHistory — fresh-signed result URLs", () => {
  it("replaces an expired stored url with a freshly-signed, currently-valid one", async () => {
    await upsertSyncedProduct(SHOP, product("product-1"));
    const productRow = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP } });

    const job = await createGenerationJob({
      shop: SHOP,
      productId: productRow.id,
      type: "PRODUCT_CLEANUP",
      sourceMediaIds: [],
      plan: plan(),
    });

    const storageKey = `shops/${SHOP}/generation/${job.id}/0.png`;
    await createResults(SHOP, job.id, [
      {
        storageKey,
        url: staleUrl(storageKey),
        width: 1024,
        height: 1024,
        format: "png",
        providerName: "deterministic-test",
        providerResultId: null,
        metadata: null,
      },
    ]);

    const loaded = await getGeneration(CONTEXT, job.id);
    const result = loaded!.results[0];

    // Not the stale URL we stored.
    expect(result.url).not.toBe(staleUrl(storageKey));

    const url = new URL(result.url!, "https://example.com");
    const isValid = verifyMediaUrlSignature(storageKey, url.searchParams.get("expires"), url.searchParams.get("sig"));
    expect(isValid).toBe(true);

    // listGenerationHistory goes through the same fix.
    const history = await listGenerationHistory(CONTEXT, productRow.id);
    const historyUrl = new URL(history[0].results[0].url!, "https://example.com");
    expect(
      verifyMediaUrlSignature(storageKey, historyUrl.searchParams.get("expires"), historyUrl.searchParams.get("sig")),
    ).toBe(true);
  });
});
