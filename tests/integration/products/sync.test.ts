/**
 * Integration tests: services/products/sync.server.ts against a real local
 * Postgres, with a fake `AdminGraphQLClient` standing in for Shopify (no
 * network call — see CLAUDE.md "Never make a real AI/Shopify API call from
 * a test").
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../../db/client.server";
import { runCatalogSync, syncSingleProduct, removeSyncedProduct } from "../../../services/products/sync.server";
import type { AdminGraphQLClient } from "../../../services/shopify/graphql.server";
import type { RawShopifyProductNode } from "../../../services/products/mapping";

const SHOP = "sync-test-shop.myshopify.com";

function productNode(id: string, overrides: Partial<RawShopifyProductNode> = {}): RawShopifyProductNode {
  return {
    id,
    title: `Product ${id}`,
    handle: `product-${id}`,
    description: "",
    productType: "Bags",
    vendor: "Acme",
    tags: [],
    status: "ACTIVE",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    category: null,
    media: { nodes: [] },
    ...overrides,
  };
}

type Page = { nodes: RawShopifyProductNode[]; hasNextPage: boolean; endCursor: string | null };

function fakeProductsClient(pages: Page[], onQuery?: (variables: Record<string, unknown>) => void): AdminGraphQLClient {
  let call = 0;
  return {
    graphql: async (_query, options) => {
      onQuery?.(options?.variables ?? {});
      const page = pages[call++] ?? { nodes: [], hasNextPage: false, endCursor: null };
      return new Response(
        JSON.stringify({
          data: { products: { pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor }, nodes: page.nodes } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  };
}

function fakeSingleProductClient(node: RawShopifyProductNode | null): AdminGraphQLClient {
  return {
    graphql: async () =>
      new Response(JSON.stringify({ data: { product: node } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  };
}

async function cleanup() {
  await prisma.shopifyProduct.deleteMany({ where: { shop: SHOP } });
  await prisma.shopSyncState.deleteMany({ where: { shop: SHOP } });
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("runCatalogSync", () => {
  it("pages through every product and upserts each, marking sync IDLE with a timestamp", async () => {
    const client = fakeProductsClient([
      { nodes: [productNode("gid://shopify/Product/1"), productNode("gid://shopify/Product/2")], hasNextPage: true, endCursor: "cursor-1" },
      { nodes: [productNode("gid://shopify/Product/3")], hasNextPage: false, endCursor: null },
    ]);

    const result = await runCatalogSync(client, SHOP, "full");

    expect(result).toEqual({ mode: "full", productsSynced: 3, pagesFetched: 2 });

    const products = await prisma.shopifyProduct.findMany({ where: { shop: SHOP } });
    expect(products).toHaveLength(3);

    const state = await prisma.shopSyncState.findUniqueOrThrow({ where: { shop: SHOP } });
    expect(state.status).toBe("IDLE");
    expect(state.lastSyncedAt).not.toBeNull();
  });

  it("scopes an incremental sync to updated_at since the last successful sync", async () => {
    await prisma.shopSyncState.create({
      data: { shop: SHOP, status: "IDLE", lastSyncedAt: new Date("2026-01-01T00:00:00Z") },
    });

    const queries: Record<string, unknown>[] = [];
    const client = fakeProductsClient(
      [{ nodes: [], hasNextPage: false, endCursor: null }],
      (variables) => queries.push(variables),
    );

    await runCatalogSync(client, SHOP, "incremental");

    expect(queries[0].query).toBe("updated_at:>='2026-01-01T00:00:00.000Z'");
  });

  it("falls back to a full sync when there is no previous successful sync", async () => {
    const queries: Record<string, unknown>[] = [];
    const client = fakeProductsClient(
      [{ nodes: [], hasNextPage: false, endCursor: null }],
      (variables) => queries.push(variables),
    );

    const result = await runCatalogSync(client, SHOP, "incremental");

    expect(result.mode).toBe("full");
    expect(queries[0].query).toBeUndefined();
  });

  it("marks the shop's sync state FAILED (with a merchant-safe message) if a page fetch throws", async () => {
    const client: AdminGraphQLClient = {
      graphql: async () => {
        throw new Error("ECONNRESET: internal Shopify detail that shouldn't leak to the merchant");
      },
    };

    await expect(runCatalogSync(client, SHOP, "full")).rejects.toThrow();

    const state = await prisma.shopSyncState.findUniqueOrThrow({ where: { shop: SHOP } });
    expect(state.status).toBe("FAILED");
    expect(state.lastError).not.toContain("ECONNRESET");
  });
});

describe("syncSingleProduct", () => {
  it("upserts the product when Shopify still has it", async () => {
    const client = fakeSingleProductClient(productNode("gid://shopify/Product/1", { title: "Webhook Synced" }));

    await syncSingleProduct(client, SHOP, "gid://shopify/Product/1");

    const row = await prisma.shopifyProduct.findUniqueOrThrow({
      where: { shop_shopifyProductId: { shop: SHOP, shopifyProductId: "gid://shopify/Product/1" } },
    });
    expect(row.title).toBe("Webhook Synced");
  });

  it("deletes the local row when Shopify no longer has the product", async () => {
    const upsertClient = fakeSingleProductClient(productNode("gid://shopify/Product/1"));
    await syncSingleProduct(upsertClient, SHOP, "gid://shopify/Product/1");

    const deleteClient = fakeSingleProductClient(null);
    await syncSingleProduct(deleteClient, SHOP, "gid://shopify/Product/1");

    const rows = await prisma.shopifyProduct.findMany({ where: { shop: SHOP } });
    expect(rows).toHaveLength(0);
  });
});

describe("removeSyncedProduct", () => {
  it("is idempotent", async () => {
    await expect(removeSyncedProduct(SHOP, "gid://shopify/Product/never-synced")).resolves.toBeUndefined();
  });
});

