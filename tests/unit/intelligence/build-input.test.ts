import { describe, expect, it } from "vitest";
import { buildAnalyzeProductInput } from "../../../services/intelligence/build-input";
import type { ProductDetail } from "../../../db/repositories/shopify-product.repository";

function product(overrides: Partial<ProductDetail> = {}): ProductDetail {
  return {
    id: "product-1",
    shop: "shop-a.myshopify.com",
    shopifyProductId: "gid://shopify/Product/1",
    title: "Red Leather Handbag",
    handle: "red-leather-handbag",
    description: "A handcrafted red leather handbag.",
    productType: "Handbags",
    category: "Apparel & Accessories > Handbags",
    vendor: "Acme",
    tags: ["leather", "bestseller"],
    status: "ACTIVE",
    syncedAt: new Date(),
    shopifyUpdatedAt: new Date("2026-01-01T00:00:00Z"),
    media: [
      { id: "media-1", originalUrl: "https://cdn/1.jpg", previewUrl: "https://cdn/1-small.jpg", altText: "Front", width: 800, height: 600, position: 0 },
      { id: "media-2", originalUrl: "https://cdn/2.jpg", previewUrl: null, altText: null, width: 800, height: 600, position: 1 },
    ],
    ...overrides,
  };
}

describe("buildAnalyzeProductInput", () => {
  it("maps the product's own text fields verbatim — never inventing or altering identity data", () => {
    const input = buildAnalyzeProductInput(product());

    expect(input.title).toBe("Red Leather Handbag");
    expect(input.description).toBe("A handcrafted red leather handbag.");
    expect(input.productType).toBe("Handbags");
    expect(input.category).toBe("Apparel & Accessories > Handbags");
    expect(input.vendor).toBe("Acme");
    expect(input.tags).toEqual(["leather", "bestseller"]);
  });

  it("maps every media row to an image reference, preserving id/url/alt/position", () => {
    const input = buildAnalyzeProductInput(product());

    expect(input.images).toEqual([
      { mediaId: "media-1", url: "https://cdn/1.jpg", altText: "Front", position: 0 },
      { mediaId: "media-2", url: "https://cdn/2.jpg", altText: null, position: 1 },
    ]);
  });

  it("uses the original (full-resolution) URL, not the preview URL", () => {
    const input = buildAnalyzeProductInput(product());
    expect(input.images[0].url).toBe("https://cdn/1.jpg");
  });

  it("produces no images for a product with none", () => {
    const input = buildAnalyzeProductInput(product({ media: [] }));
    expect(input.images).toEqual([]);
  });
});
