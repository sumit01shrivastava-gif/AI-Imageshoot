/**
 * Product Intelligence — service entry point used by routes.
 *
 * `requestProductAnalysis` is the only mutating entry point (queues
 * analysis); `getProductIntelligence` is the read path. Both take an
 * `AuthContext` and re-verify shop ownership of the given product id via
 * the existing Phase 1 repository — never trust a client-supplied product
 * id (see CLAUDE.md "Security requirements").
 */
import type { AuthContext } from "../../lib/auth/types";
import { findProductForShop } from "../../db/repositories/shopify-product.repository";
import { TenantMismatchError } from "../../lib/auth/tenant.server";
import {
  getForProduct,
  ensurePendingAnalysis,
  type ProductIntelligenceRow,
} from "../../db/repositories/product-intelligence.repository";
import { enqueueProductIntelligenceAnalysis } from "./queue.server";

/**
 * Deliberately the SAME error for "doesn't exist" and "belongs to another
 * shop" — see app/routes/app.products.$id.tsx's loader and the Phase 0/1
 * security audit ("existence oracle" finding): a client-supplied product
 * id that doesn't check out must never be distinguishable from one that
 * simply doesn't exist.
 */
export class ProductNotFoundError extends Error {
  constructor() {
    super("Product not found");
    this.name = "ProductNotFoundError";
  }
}

/**
 * Requests (or re-requests) analysis for one product. Safe to call
 * repeatedly — re-analysis included: a fresh job is always queued (see
 * lib/queue/queue.server.ts's dedup semantics), and the existing profile
 * (if any) is left untouched until that job actually starts, so the UI
 * keeps showing the last good result rather than blanking out.
 *
 * Never analyzes anything on its own — this is only ever called from an
 * explicit merchant action (see CLAUDE.md/docs/product-intelligence.md
 * "Performance": no automatic bulk analysis).
 */
export async function requestProductAnalysis(context: AuthContext, productId: string): Promise<void> {
  let product: Awaited<ReturnType<typeof findProductForShop>>;
  try {
    product = await findProductForShop(context, productId);
  } catch (error) {
    if (error instanceof TenantMismatchError) {
      throw new ProductNotFoundError();
    }
    throw error;
  }

  if (!product) {
    throw new ProductNotFoundError();
  }

  await ensurePendingAnalysis(context.shop, productId);
  await enqueueProductIntelligenceAnalysis({ shop: context.shop, productId });
}

export async function getProductIntelligence(
  context: AuthContext,
  productId: string,
): Promise<ProductIntelligenceRow | null> {
  return getForProduct(context, productId);
}

export { isIntelligenceStale, getIntelligenceDisplayState } from "./stale";
export type { IntelligenceDisplayState } from "./stale";
