/**
 * Repository for `ImageSelection` / `ImageSelectionItem` — the persisted
 * record of a merchant's chosen source images (see prisma/schema.prisma's
 * model comment and services/products/selection.server.ts, which owns the
 * validation rules this repository enforces at the data layer).
 */
import prisma from "../client.server";
import type { AuthContext } from "../../lib/auth/types";
import { assertShopOwnership } from "../../lib/auth/tenant.server";
import type { SelectionInput, SelectionSummary } from "../../services/products/types";

export class InvalidSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSelectionError";
  }
}

/**
 * Creates a new `ImageSelection` with the given items. Every referenced
 * `productMediaId` is re-verified server-side — belongs to this shop, and
 * belongs to the given `productId` — before anything is written; a
 * client-supplied id that doesn't check out throws `InvalidSelectionError`
 * rather than silently dropping or cross-tenant-leaking it (see CLAUDE.md
 * "Security requirements").
 */
export async function createSelection(
  context: AuthContext,
  items: SelectionInput[],
): Promise<string> {
  if (items.length === 0) {
    throw new InvalidSelectionError("Cannot create a selection with zero images.");
  }

  const mediaIds = [...new Set(items.map((item) => item.productMediaId))];
  const mediaRows = await prisma.shopifyProductMedia.findMany({
    where: { id: { in: mediaIds } },
    select: { id: true, shop: true, productId: true },
  });

  const mediaById = new Map(mediaRows.map((row) => [row.id, row]));
  for (const item of items) {
    const media = mediaById.get(item.productMediaId);
    if (!media) {
      throw new InvalidSelectionError("One or more selected images could not be found.");
    }
    if (media.shop !== context.shop) {
      throw new InvalidSelectionError("One or more selected images do not belong to this shop.");
    }
    if (media.productId !== item.productId) {
      throw new InvalidSelectionError("One or more selected images do not belong to the given product.");
    }
  }

  const uniqueItems = [...new Map(items.map((item) => [item.productMediaId, item])).values()];

  const selection = await prisma.imageSelection.create({
    data: {
      shop: context.shop,
      items: {
        create: uniqueItems.map((item) => ({
          shop: context.shop,
          productId: item.productId,
          productMediaId: item.productMediaId,
        })),
      },
    },
    select: { id: true },
  });

  return selection.id;
}

/** Loads a selection's summary (grouped by product) for the confirmation
 * screen. Verifies shop ownership before returning. Returns `null` if not
 * found for this shop. */
export async function getSelectionSummary(
  context: AuthContext,
  selectionId: string,
): Promise<SelectionSummary | null> {
  const selection = await prisma.imageSelection.findUnique({
    where: { id: selectionId },
    select: {
      id: true,
      shop: true,
      items: {
        select: {
          productMedia: {
            select: {
              id: true,
              originalUrl: true,
              altText: true,
              product: { select: { id: true, title: true, handle: true } },
            },
          },
        },
      },
    },
  });

  if (!selection) return null;
  assertShopOwnership(context, selection.shop);

  const byProduct = new Map<
    string,
    { productId: string; title: string; handle: string; images: SelectionSummary["products"][number]["images"] }
  >();

  for (const item of selection.items) {
    const product = item.productMedia.product;
    const existing = byProduct.get(product.id);
    const image = {
      productMediaId: item.productMedia.id,
      url: item.productMedia.originalUrl,
      altText: item.productMedia.altText,
    };
    if (existing) {
      existing.images.push(image);
    } else {
      byProduct.set(product.id, {
        productId: product.id,
        title: product.title,
        handle: product.handle,
        images: [image],
      });
    }
  }

  const products = [...byProduct.values()].map((entry) => ({
    productId: entry.productId,
    title: entry.title,
    handle: entry.handle,
    thumbnailUrl: entry.images[0]?.url ?? null,
    images: entry.images,
  }));

  return {
    selectionId: selection.id,
    productCount: products.length,
    imageCount: selection.items.length,
    products,
  };
}
