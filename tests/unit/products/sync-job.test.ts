import { describe, expect, it } from "vitest";
import { catalogSyncJobId } from "../../../services/products/sync-job.server";

describe("catalogSyncJobId", () => {
  it("is deterministic for the same payload, so BullMQ collapses repeat deliveries", () => {
    const payload = {
      type: "product-upsert" as const,
      shop: "shop-a.myshopify.com",
      shopifyProductId: "gid://shopify/Product/1",
    };

    expect(catalogSyncJobId(payload)).toBe(catalogSyncJobId({ ...payload }));
  });

  it("differs by shop, type, and product id", () => {
    const ids = new Set([
      catalogSyncJobId({ type: "full-sync", shop: "a.myshopify.com", mode: "full" }),
      catalogSyncJobId({ type: "full-sync", shop: "b.myshopify.com", mode: "full" }),
      catalogSyncJobId({
        type: "product-upsert",
        shop: "a.myshopify.com",
        shopifyProductId: "gid://shopify/Product/1",
      }),
      catalogSyncJobId({
        type: "product-upsert",
        shop: "a.myshopify.com",
        shopifyProductId: "gid://shopify/Product/2",
      }),
      catalogSyncJobId({
        type: "product-delete",
        shop: "a.myshopify.com",
        shopifyProductId: "gid://shopify/Product/1",
      }),
    ]);

    expect(ids.size).toBe(5);
  });

  it("never contains a ':' — BullMQ rejects a custom jobId containing ':' unless it splits into exactly 3 parts (see bullmq's Job.validateOptions), and Shopify's GraphQL ids (e.g. 'gid://shopify/Product/1') contain one", () => {
    const ids = [
      catalogSyncJobId({ type: "full-sync", shop: "a.myshopify.com", mode: "full" }),
      catalogSyncJobId({
        type: "product-upsert",
        shop: "a.myshopify.com",
        shopifyProductId: "gid://shopify/Product/1",
      }),
      catalogSyncJobId({
        type: "product-delete",
        shop: "a.myshopify.com",
        shopifyProductId: "gid://shopify/Product/1",
      }),
    ];

    for (const id of ids) {
      expect(id).not.toContain(":");
    }
  });

  it("is not parseable as an integer (BullMQ also rejects that)", () => {
    const id = catalogSyncJobId({ type: "full-sync", shop: "a.myshopify.com", mode: "full" });
    expect(Number.isNaN(Number(id))).toBe(true);
  });
});
