import { describe, expect, it } from "vitest";
import { mapProductNode, UnknownProductStatusError, type RawShopifyProductNode } from "../../../services/products/mapping";

function baseNode(overrides: Partial<RawShopifyProductNode> = {}): RawShopifyProductNode {
  return {
    id: "gid://shopify/Product/1",
    title: "Premium Leather Bag",
    handle: "premium-leather-bag",
    description: "A handcrafted leather bag.",
    productType: "Bags",
    vendor: "Acme",
    tags: ["leather", "bestseller"],
    status: "ACTIVE",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    category: { id: "gid://shopify/TaxonomyCategory/ap-4", fullName: "Apparel & Accessories > Bags" },
    media: { nodes: [] },
    ...overrides,
  };
}

describe("mapProductNode", () => {
  it("maps a product's scalar fields", () => {
    const result = mapProductNode(baseNode());

    expect(result).toMatchObject({
      shopifyProductId: "gid://shopify/Product/1",
      title: "Premium Leather Bag",
      handle: "premium-leather-bag",
      description: "A handcrafted leather bag.",
      productType: "Bags",
      category: "Apparel & Accessories > Bags",
      vendor: "Acme",
      tags: ["leather", "bestseller"],
      status: "ACTIVE",
    });
    expect(result.shopifyCreatedAt).toEqual(new Date("2026-01-01T00:00:00Z"));
    expect(result.shopifyUpdatedAt).toEqual(new Date("2026-01-02T00:00:00Z"));
  });

  it("defaults nullable Shopify fields to safe values", () => {
    const result = mapProductNode(
      baseNode({ description: null, productType: null, vendor: null, tags: null, category: null }),
    );

    expect(result.description).toBe("");
    expect(result.productType).toBe("");
    expect(result.vendor).toBe("");
    expect(result.tags).toEqual([]);
    expect(result.category).toBeNull();
  });

  it("keeps only IMAGE media, mapping image + thumbnail URLs", () => {
    const result = mapProductNode(
      baseNode({
        media: {
          nodes: [
            {
              id: "gid://shopify/MediaImage/1",
              alt: "Bag front",
              mediaContentType: "IMAGE",
              image: { url: "https://cdn.shopify.com/1.jpg", width: 800, height: 600 },
              thumbnail: { url: "https://cdn.shopify.com/1-small.jpg" },
            },
            {
              id: "gid://shopify/Video/1",
              alt: null,
              mediaContentType: "VIDEO",
              image: null,
              thumbnail: null,
            },
          ],
        },
      }),
    );

    expect(result.media).toEqual([
      {
        shopifyMediaId: "gid://shopify/MediaImage/1",
        mediaType: "IMAGE",
        originalUrl: "https://cdn.shopify.com/1.jpg",
        previewUrl: "https://cdn.shopify.com/1-small.jpg",
        width: 800,
        height: 600,
        altText: "Bag front",
        position: 0,
      },
    ]);
  });

  it("re-indexes media positions contiguously after filtering out non-image media", () => {
    const result = mapProductNode(
      baseNode({
        media: {
          nodes: [
            { id: "v1", alt: null, mediaContentType: "VIDEO", image: null, thumbnail: null },
            {
              id: "i1",
              alt: "first",
              mediaContentType: "IMAGE",
              image: { url: "https://cdn/1.jpg", width: 1, height: 1 },
              thumbnail: null,
            },
            {
              id: "i2",
              alt: "second",
              mediaContentType: "IMAGE",
              image: { url: "https://cdn/2.jpg", width: 1, height: 1 },
              thumbnail: null,
            },
          ],
        },
      }),
    );

    expect(result.media.map((m) => m.position)).toEqual([0, 1]);
    expect(result.media.map((m) => m.shopifyMediaId)).toEqual(["i1", "i2"]);
  });

  it("throws UnknownProductStatusError for a status outside ACTIVE/ARCHIVED/DRAFT", () => {
    expect(() => mapProductNode(baseNode({ status: "SOMETHING_NEW" }))).toThrow(
      UnknownProductStatusError,
    );
  });
});
