/**
 * Tenant (shop) isolation guard.
 *
 * Security rule (see CLAUDE.md "Security Requirements"): never trust a
 * shopId/shop domain — or any other ownership identifier — supplied by the
 * browser. Every future repository/service that loads a resource by an
 * id coming from a request (query param, body, route param) MUST call
 * `assertShopOwnership` with the shop from the server-derived AuthContext
 * before returning or mutating that resource.
 *
 * There are no domain resources yet (Phase 0), so nothing calls this yet —
 * it exists now so that pattern is established before any resource-owning
 * model is added.
 */
import type { AuthContext } from "./types";

export class TenantMismatchError extends Error {
  constructor(expectedShop: string) {
    super(`Resource does not belong to shop "${expectedShop}"`);
    this.name = "TenantMismatchError";
  }
}

/**
 * Throws TenantMismatchError unless `resourceShop` matches the
 * authenticated shop in `context`. Call this after loading a resource and
 * before returning/mutating it — never trust a shop id supplied by the
 * client without this check.
 */
export function assertShopOwnership(context: AuthContext, resourceShop: string): void {
  if (context.shop !== resourceShop) {
    throw new TenantMismatchError(context.shop);
  }
}
