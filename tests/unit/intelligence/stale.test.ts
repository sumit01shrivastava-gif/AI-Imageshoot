import { describe, expect, it } from "vitest";
import { isIntelligenceStale, getIntelligenceDisplayState } from "../../../services/intelligence/stale";

const PRODUCT_UPDATED = new Date("2026-01-10T00:00:00Z");

describe("isIntelligenceStale", () => {
  it("is false when there's no intelligence profile at all", () => {
    expect(isIntelligenceStale(null, { shopifyUpdatedAt: PRODUCT_UPDATED })).toBe(false);
  });

  it("is false for a non-READY profile (PENDING/PROCESSING/FAILED aren't 'stale', they're their own state)", () => {
    for (const status of ["PENDING", "PROCESSING", "FAILED"] as const) {
      expect(
        isIntelligenceStale(
          { status, sourceShopifyUpdatedAt: new Date("2026-01-01T00:00:00Z") },
          { shopifyUpdatedAt: PRODUCT_UPDATED },
        ),
      ).toBe(false);
    }
  });

  it("is false for a READY profile with no recorded watermark (shouldn't happen, but never a false positive)", () => {
    expect(
      isIntelligenceStale({ status: "READY", sourceShopifyUpdatedAt: null }, { shopifyUpdatedAt: PRODUCT_UPDATED }),
    ).toBe(false);
  });

  it("is false when the profile's watermark is at or after the product's last Shopify update", () => {
    expect(
      isIntelligenceStale(
        { status: "READY", sourceShopifyUpdatedAt: PRODUCT_UPDATED },
        { shopifyUpdatedAt: PRODUCT_UPDATED },
      ),
    ).toBe(false);

    const later = new Date(PRODUCT_UPDATED.getTime() + 1000);
    expect(
      isIntelligenceStale({ status: "READY", sourceShopifyUpdatedAt: later }, { shopifyUpdatedAt: PRODUCT_UPDATED }),
    ).toBe(false);
  });

  it("is true when the product was updated on Shopify after the profile was analyzed", () => {
    const earlier = new Date(PRODUCT_UPDATED.getTime() - 1000);
    expect(
      isIntelligenceStale(
        { status: "READY", sourceShopifyUpdatedAt: earlier },
        { shopifyUpdatedAt: PRODUCT_UPDATED },
      ),
    ).toBe(true);
  });
});

describe("getIntelligenceDisplayState", () => {
  const product = { shopifyUpdatedAt: PRODUCT_UPDATED };

  it("is 'not_analyzed' when there's no profile", () => {
    expect(getIntelligenceDisplayState(null, product)).toBe("not_analyzed");
  });

  it("is 'not_analyzed' for a PENDING profile", () => {
    expect(
      getIntelligenceDisplayState({ status: "PENDING", sourceShopifyUpdatedAt: null }, product),
    ).toBe("not_analyzed");
  });

  it("is 'analyzing' for a PROCESSING profile", () => {
    expect(
      getIntelligenceDisplayState({ status: "PROCESSING", sourceShopifyUpdatedAt: null }, product),
    ).toBe("analyzing");
  });

  it("is 'failed' for a FAILED profile", () => {
    expect(
      getIntelligenceDisplayState({ status: "FAILED", sourceShopifyUpdatedAt: null }, product),
    ).toBe("failed");
  });

  it("is 'ready' for a READY, up-to-date profile", () => {
    expect(
      getIntelligenceDisplayState({ status: "READY", sourceShopifyUpdatedAt: PRODUCT_UPDATED }, product),
    ).toBe("ready");
  });

  it("is 'stale' for a READY profile whose product has since changed", () => {
    const earlier = new Date(PRODUCT_UPDATED.getTime() - 1000);
    expect(
      getIntelligenceDisplayState({ status: "READY", sourceShopifyUpdatedAt: earlier }, product),
    ).toBe("stale");
  });
});
