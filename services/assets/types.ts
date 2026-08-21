/**
 * Asset Library types/constants — deliberately NOT `.server.ts`.
 * `app/routes/app.assets.tsx`'s component (client-rendered) needs
 * `ASSET_KINDS` at runtime (to render the Source filter's options);
 * React Router strips server-only code from a route's `loader`/`action`
 * but NOT from its other exports, so a runtime value the component body
 * uses can't live in a `.server.ts` file — see
 * https://reactrouter.com/explanation/code-splitting#removal-of-server-code.
 * `services/assets/asset-library.server.ts` (the actual query/merge
 * logic, server-only) imports these from here rather than the reverse.
 */
import type { GenerationType, ImageOperation, ReviewStatus, StoreVisualType } from "@prisma/client";

export const ASSET_KINDS = ["GENERATION", "PROCESSING", "STORE_VISUAL"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const ASSET_SCOPE_BY_KIND: Record<AssetKind, "PRODUCT" | "STORE"> = {
  GENERATION: "PRODUCT",
  PROCESSING: "PRODUCT",
  STORE_VISUAL: "STORE",
};

export interface AssetItem {
  id: string;
  kind: AssetKind;
  subtype: GenerationType | ImageOperation | StoreVisualType;
  scope: "PRODUCT" | "STORE";
  /** The owning job's id — used to link back to that domain's existing
   * detail page (GENERATION/PROCESSING both link to the product detail
   * page; STORE_VISUAL links to its own /app/store-visuals/:jobId page —
   * neither domain has a separate per-result page). */
  jobId: string;
  productId: string | null;
  /** GENERATION/PROCESSING: the single owning product's title.
   * STORE_VISUAL: up to 3 featured products' titles, joined — `null` for
   * a fully generic store visual with no product reference. */
  productTitle: string | null;
  url: string | null;
  width: number | null;
  height: number | null;
  format: string | null;
  reviewStatus: ReviewStatus;
  createdAt: Date;
}

export interface AssetLibraryFilters {
  kind?: AssetKind;
  status?: ReviewStatus;
}

export interface AssetLibraryPage {
  items: AssetItem[];
  total: number;
  page: number;
  pageSize: number;
}

export const ASSET_LIBRARY_PAGE_SIZE = 20;
