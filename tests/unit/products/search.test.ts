import { describe, expect, it } from "vitest";
import {
  buildProductListWhere,
  clampPage,
} from "../../../db/repositories/shopify-product.repository";

describe("buildProductListWhere", () => {
  it("always scopes to the given shop", () => {
    const where = buildProductListWhere("shop-a.myshopify.com", {});
    expect(where).toEqual({ shop: "shop-a.myshopify.com" });
  });

  it("adds a status filter when provided", () => {
    const where = buildProductListWhere("shop-a.myshopify.com", { status: "ACTIVE" });
    expect(where).toMatchObject({ shop: "shop-a.myshopify.com", status: "ACTIVE" });
  });

  it("builds a case-insensitive OR search across title/handle/productType/vendor, plus exact tag match", () => {
    const where = buildProductListWhere("shop-a.myshopify.com", { search: "Bag" });

    expect(where.OR).toEqual([
      { title: { contains: "Bag", mode: "insensitive" } },
      { handle: { contains: "Bag", mode: "insensitive" } },
      { productType: { contains: "Bag", mode: "insensitive" } },
      { vendor: { contains: "Bag", mode: "insensitive" } },
      { tags: { has: "Bag" } },
    ]);
  });

  it("trims whitespace and ignores an empty search term", () => {
    const where = buildProductListWhere("shop-a.myshopify.com", { search: "   " });
    expect(where.OR).toBeUndefined();
  });

  it("never lets a search value leak in as the shop", () => {
    // Defensive: filters is caller-controlled (query params); shop always
    // comes from the caller's own first argument, not from `filters`.
    const where = buildProductListWhere("shop-a.myshopify.com", {
      search: "shop-b.myshopify.com",
    } as never);
    expect(where.shop).toBe("shop-a.myshopify.com");
  });
});

describe("clampPage", () => {
  it("defaults to 1 for missing/invalid values", () => {
    expect(clampPage(undefined)).toBe(1);
    expect(clampPage(null)).toBe(1);
    expect(clampPage(0)).toBe(1);
    expect(clampPage(-5)).toBe(1);
    expect(clampPage(Number.NaN)).toBe(1);
  });

  it("floors a fractional page", () => {
    expect(clampPage(2.9)).toBe(2);
  });

  it("passes through a valid page", () => {
    expect(clampPage(7)).toBe(7);
  });
});
