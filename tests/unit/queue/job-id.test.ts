import { describe, expect, it } from "vitest";
import { buildJobId } from "../../../lib/queue/job-id";

describe("buildJobId", () => {
  it("is deterministic for the same prefix + parts", () => {
    expect(buildJobId("product-intelligence", "shop-a", "product-1")).toBe(
      buildJobId("product-intelligence", "shop-a", "product-1"),
    );
  });

  it("differs by prefix", () => {
    expect(buildJobId("full-sync", "shop-a")).not.toBe(buildJobId("product-intelligence", "shop-a"));
  });

  it("differs by parts, even when naively concatenated they'd look the same", () => {
    const a = buildJobId("x", "ab", "c");
    const b = buildJobId("x", "a", "bc");
    expect(a).not.toBe(b);
  });

  it("never contains a ':' — BullMQ rejects a custom jobId containing ':' unless it splits into exactly 3 parts (see bullmq's Job.validateOptions), and ids this is built from (e.g. Shopify GraphQL ids) can contain one", () => {
    const id = buildJobId("product-upsert", "shop-a.myshopify.com", "gid://shopify/Product/123");
    expect(id).not.toContain(":");
  });

  it("is not parseable as an integer (BullMQ also rejects that)", () => {
    const id = buildJobId("full-sync", "shop-a");
    expect(Number.isNaN(Number(id))).toBe(true);
  });
});
