/**
 * Unit tests: services/shopify/publish-media.server.ts — the pure
 * mutation-variable builder and `publishMediaToProduct`'s error
 * classification. `unauthenticated.admin`/`executeAdminGraphQL` are
 * mocked — this app has no live Shopify session/write scope in this
 * environment (see that file's own doc comment), so these tests prove
 * the REQUEST/RESPONSE handling logic is correct without a live call.
 */
import { describe, expect, it, vi } from "vitest";
import { buildPublishMediaVariables } from "../../../services/shopify/publish-media.server";

describe("buildPublishMediaVariables", () => {
  it("maps a PublishMediaInput into productCreateMedia's variables shape", () => {
    const variables = buildPublishMediaVariables({
      shopifyProductId: "gid://shopify/Product/123",
      imageUrl: "https://app.example.com/media/shops/x/generation/1/0.png?expires=1&sig=abc",
      altText: "A red leather handbag",
    });

    expect(variables).toEqual({
      productId: "gid://shopify/Product/123",
      media: [
        {
          originalSource: "https://app.example.com/media/shops/x/generation/1/0.png?expires=1&sig=abc",
          alt: "A red leather handbag",
          mediaContentType: "IMAGE",
        },
      ],
    });
  });

  it("defaults alt text to an empty string when null", () => {
    const variables = buildPublishMediaVariables({
      shopifyProductId: "gid://shopify/Product/123",
      imageUrl: "https://app.example.com/media/x.png",
      altText: null,
    });
    expect(variables.media[0].alt).toBe("");
  });
});

vi.mock("../../../services/shopify/client.server", () => ({
  unauthenticated: { admin: vi.fn() },
}));

const executeAdminGraphQLMock = vi.fn();
vi.mock("../../../services/shopify/graphql.server", async () => {
  const actual = await vi.importActual<typeof import("../../../services/shopify/graphql.server")>(
    "../../../services/shopify/graphql.server",
  );
  return { ...actual, executeAdminGraphQL: (...args: unknown[]) => executeAdminGraphQLMock(...args) };
});

describe("publishMediaToProduct", () => {
  const INPUT = { shopifyProductId: "gid://shopify/Product/1", imageUrl: "https://x.test/a.png", altText: null };

  it("returns the created media id on success", async () => {
    const { unauthenticated } = await import("../../../services/shopify/client.server");
    (unauthenticated.admin as ReturnType<typeof vi.fn>).mockResolvedValue({ admin: { graphql: vi.fn() }, session: {} });
    executeAdminGraphQLMock.mockResolvedValue({
      productCreateMedia: { media: [{ id: "gid://shopify/MediaImage/999" }], mediaUserErrors: [] },
    });

    const { publishMediaToProduct } = await import("../../../services/shopify/publish-media.server");
    const result = await publishMediaToProduct("shop.myshopify.com", INPUT);
    expect(result).toEqual({ shopifyMediaId: "gid://shopify/MediaImage/999" });
  });

  it("throws ShopifyPublishError with isPermissionError=true for a scope/permission-shaped userError", async () => {
    const { unauthenticated } = await import("../../../services/shopify/client.server");
    (unauthenticated.admin as ReturnType<typeof vi.fn>).mockResolvedValue({ admin: { graphql: vi.fn() }, session: {} });
    executeAdminGraphQLMock.mockResolvedValue({
      productCreateMedia: { media: [], mediaUserErrors: [{ field: null, message: "Access denied for productCreateMedia" }] },
    });

    const { publishMediaToProduct, ShopifyPublishError } = await import("../../../services/shopify/publish-media.server");
    await expect(publishMediaToProduct("shop.myshopify.com", INPUT)).rejects.toBeInstanceOf(ShopifyPublishError);
    try {
      await publishMediaToProduct("shop.myshopify.com", INPUT);
    } catch (error) {
      expect((error as InstanceType<typeof ShopifyPublishError>).isPermissionError).toBe(true);
    }
  });

  it("throws ShopifyPublishError (not permission-flagged) for a non-permission GraphQL failure", async () => {
    const { unauthenticated } = await import("../../../services/shopify/client.server");
    (unauthenticated.admin as ReturnType<typeof vi.fn>).mockResolvedValue({ admin: { graphql: vi.fn() }, session: {} });
    executeAdminGraphQLMock.mockRejectedValue(new Error("Shopify Admin API responded with HTTP 500."));

    const { publishMediaToProduct, ShopifyPublishError } = await import("../../../services/shopify/publish-media.server");
    try {
      await publishMediaToProduct("shop.myshopify.com", INPUT);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ShopifyPublishError);
      expect((error as InstanceType<typeof ShopifyPublishError>).isPermissionError).toBe(false);
    }
  });

  it("throws a clear ShopifyPublishError when the shop has no stored session (app uninstalled)", async () => {
    const { unauthenticated } = await import("../../../services/shopify/client.server");
    (unauthenticated.admin as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("no session found"));

    const { publishMediaToProduct, ShopifyPublishError } = await import("../../../services/shopify/publish-media.server");
    await expect(publishMediaToProduct("shop.myshopify.com", INPUT)).rejects.toBeInstanceOf(ShopifyPublishError);
  });
});
