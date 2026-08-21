/**
 * AI Assets — a shop-wide, read-only, most-recent-first library merging
 * `GenerationResult` (Lifestyle/Model Shoot/Banner/CTA/Product Cleanup),
 * `ProcessingResult` (Remove Background/Enhance/Resize/...), and
 * `StoreVisualResult` (Homepage Hero/Collection Banner/Store CTA) into
 * one normalized, filterable, paginated list. See
 * docs/asset-library.md.
 *
 * Deliberately NOT a DAM system: no tagging, no albums, no bulk actions,
 * no search-by-content — just "show me everything this shop has
 * generated, newest first, filterable by source/status." Review/approve/
 * reject/regenerate already live on each domain's own detail page (see
 * "Review experience" in docs/asset-library.md); this page links out to
 * those rather than re-implementing review actions inline.
 *
 * `kind` doubles as the "type" AND "product/store scope" filter: Generation
 * and Processing results are always product-scoped (`scope: "PRODUCT"`,
 * every row has a `productId`) and StoreVisual results are always
 * store-scoped (`scope: "STORE"`) — there is no case where the same
 * `kind` spans both scopes, so a separate scope selector would just be a
 * less specific version of the same choice. A finer-grained subtype
 * filter (the 9 GenerationTypes / 6 ImageOperations / 3 StoreVisualTypes)
 * is shown as a label on each row but is NOT independently filterable —
 * 18 additional filter values for a page whose entire purpose is staying
 * simple would be over-building a v1.
 *
 * Merge strategy — bounded fetch, not a raw SQL UNION: when `kind` is
 * set, this is a single table's own exact `skip`/`take` pagination (see
 * `listGenerationResultsForShop`'s siblings — no approximation). When
 * `kind` is unset (browsing everything), each of the three domains'
 * `list*ResultsForShop` functions is called with a BOUNDED depth
 * (`min(page * pageSize, MAX_FETCH_PER_SOURCE)`, never "all of a shop's
 * history" — the "unlimited history load" the instructions call out to
 * avoid), the results are merged and sorted by `createdAt` in
 * application code, then sliced to the requested page. `total` is still
 * an exact count (a `COUNT` per domain is cheap even though the fetch
 * side is bounded), so pagination controls stay accurate; the merged
 * ORDERING only stays exactly correct within the first
 * `MAX_FETCH_PER_SOURCE` results per domain — deep pagination (well
 * beyond what a merchant realistically browses to) can very rarely
 * interleave slightly out of order across domains. This trade-off is
 * explicit and documented rather than silently approximate.
 */
import type { GenerationType, ImageOperation, ReviewStatus, StoreVisualType } from "@prisma/client";
import type { AuthContext } from "../../lib/auth/types";
import { resignResultUrls } from "../../lib/storage";
import { listGenerationResultsForShop, countGenerationResultsForShop } from "../../db/repositories/generation-job.repository";
import { listProcessingResultsForShop, countProcessingResultsForShop } from "../../db/repositories/processing-job.repository";
import { listStoreVisualResultsForShop, countStoreVisualResultsForShop } from "../../db/repositories/store-visual-job.repository";
import { ASSET_LIBRARY_PAGE_SIZE, type AssetItem, type AssetLibraryFilters, type AssetLibraryPage } from "./types";

// Re-exported so existing importers of this module (routes, tests) don't
// need to know the constants/types moved to a sibling non-`.server.ts`
// module — see services/assets/types.ts's doc comment for why they live
// there now.
export { ASSET_KINDS, ASSET_SCOPE_BY_KIND, ASSET_LIBRARY_PAGE_SIZE, type AssetKind, type AssetItem, type AssetLibraryFilters, type AssetLibraryPage } from "./types";

/** Bounds how deep the cross-domain fetch side goes when `kind` is unset
 * — see this module's doc comment. */
const MAX_FETCH_PER_SOURCE = 300;

function clampPage(page: number): number {
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

/** Fetches one page of the Asset Library for a shop. Never trusts a
 * client-supplied shop — `context.shop` (server-derived) scopes every
 * underlying query, same as every other repository call in this
 * codebase. */
export async function listAssetLibrary(
  context: AuthContext,
  filters: AssetLibraryFilters,
  page: number,
  pageSize: number = ASSET_LIBRARY_PAGE_SIZE,
): Promise<AssetLibraryPage> {
  const safePage = clampPage(page);
  const shop = context.shop;

  const includeGeneration = !filters.kind || filters.kind === "GENERATION";
  const includeProcessing = !filters.kind || filters.kind === "PROCESSING";
  const includeStoreVisual = !filters.kind || filters.kind === "STORE_VISUAL";

  // Single-kind selection: exact, ordinary single-table pagination — no
  // merge, no bound needed.
  if (filters.kind) {
    const skip = (safePage - 1) * pageSize;
    if (filters.kind === "GENERATION") {
      const [rows, total] = await Promise.all([
        listGenerationResultsForShop(shop, { status: filters.status }, skip + pageSize),
        countGenerationResultsForShop(shop, { status: filters.status }),
      ]);
      const page = rows.slice(skip, skip + pageSize);
      return { items: await toAssetItems(page.map(fromGenerationRow)), total, page: safePage, pageSize };
    }
    if (filters.kind === "PROCESSING") {
      const [rows, total] = await Promise.all([
        listProcessingResultsForShop(shop, { status: filters.status }, skip + pageSize),
        countProcessingResultsForShop(shop, { status: filters.status }),
      ]);
      const page = rows.slice(skip, skip + pageSize);
      return { items: await toAssetItems(page.map(fromProcessingRow)), total, page: safePage, pageSize };
    }
    // STORE_VISUAL
    const [rows, total] = await Promise.all([
      listStoreVisualResultsForShop(shop, { status: filters.status }, skip + pageSize),
      countStoreVisualResultsForShop(shop, { status: filters.status }),
    ]);
    const page = rows.slice(skip, skip + pageSize);
    return { items: await toAssetItems(page.map(fromStoreVisualRow)), total, page: safePage, pageSize };
  }

  // No kind filter: bounded fan-out merge across all three domains.
  const fetchDepth = Math.min(safePage * pageSize, MAX_FETCH_PER_SOURCE);
  const [generationRows, processingRows, storeVisualRows, generationTotal, processingTotal, storeVisualTotal] = await Promise.all([
    includeGeneration ? listGenerationResultsForShop(shop, { status: filters.status }, fetchDepth) : Promise.resolve([]),
    includeProcessing ? listProcessingResultsForShop(shop, { status: filters.status }, fetchDepth) : Promise.resolve([]),
    includeStoreVisual ? listStoreVisualResultsForShop(shop, { status: filters.status }, fetchDepth) : Promise.resolve([]),
    includeGeneration ? countGenerationResultsForShop(shop, { status: filters.status }) : Promise.resolve(0),
    includeProcessing ? countProcessingResultsForShop(shop, { status: filters.status }) : Promise.resolve(0),
    includeStoreVisual ? countStoreVisualResultsForShop(shop, { status: filters.status }) : Promise.resolve(0),
  ]);

  const merged = [...generationRows.map(fromGenerationRow), ...processingRows.map(fromProcessingRow), ...storeVisualRows.map(fromStoreVisualRow)];
  merged.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const skip = (safePage - 1) * pageSize;
  const pageItems = merged.slice(skip, skip + pageSize);
  const total = generationTotal + processingTotal + storeVisualTotal;

  return { items: await toAssetItems(pageItems), total, page: safePage, pageSize };
}

// resignResultUrls needs each item's `storageKey`; `AssetItem` (the
// public return shape) deliberately doesn't expose one (internal detail,
// never leaked to the client — see CLAUDE.md "Storage rules"/"no
// internal-path exposure"). `fromGenerationRow`/etc. below produce this
// wider internal shape; `toAssetItems` strips `storageKey` back off on
// the way out — no shared mutable state needed to thread it through.
type AssetItemWithKey = AssetItem & { storageKey: string };

async function toAssetItems(items: AssetItemWithKey[]): Promise<AssetItem[]> {
  const resigned = await resignResultUrls(items);
  return resigned.map((item) => ({
    id: item.id,
    kind: item.kind,
    subtype: item.subtype,
    scope: item.scope,
    jobId: item.jobId,
    productId: item.productId,
    productTitle: item.productTitle,
    url: item.url,
    width: item.width,
    height: item.height,
    format: item.format,
    reviewStatus: item.reviewStatus,
    createdAt: item.createdAt,
  }));
}

function fromGenerationRow(row: {
  id: string;
  storageKey: string;
  url: string | null;
  width: number | null;
  height: number | null;
  format: string | null;
  reviewStatus: ReviewStatus;
  createdAt: Date;
  generationJob: { id: string; type: GenerationType; productId: string; product: { title: string } };
}): AssetItemWithKey {
  return {
    id: row.id,
    kind: "GENERATION",
    subtype: row.generationJob.type,
    scope: "PRODUCT",
    jobId: row.generationJob.id,
    productId: row.generationJob.productId,
    productTitle: row.generationJob.product.title,
    url: row.url,
    width: row.width,
    height: row.height,
    format: row.format,
    reviewStatus: row.reviewStatus,
    createdAt: row.createdAt,
    storageKey: row.storageKey,
  };
}

function fromProcessingRow(row: {
  id: string;
  storageKey: string;
  url: string | null;
  width: number | null;
  height: number | null;
  format: string | null;
  reviewStatus: ReviewStatus;
  createdAt: Date;
  processingJob: { id: string; operation: ImageOperation; productId: string; product: { title: string } };
}): AssetItemWithKey {
  return {
    id: row.id,
    kind: "PROCESSING",
    subtype: row.processingJob.operation,
    scope: "PRODUCT",
    jobId: row.processingJob.id,
    productId: row.processingJob.productId,
    productTitle: row.processingJob.product.title,
    url: row.url,
    width: row.width,
    height: row.height,
    format: row.format,
    reviewStatus: row.reviewStatus,
    createdAt: row.createdAt,
    storageKey: row.storageKey,
  };
}

function fromStoreVisualRow(row: {
  id: string;
  storageKey: string;
  url: string | null;
  width: number | null;
  height: number | null;
  format: string | null;
  reviewStatus: ReviewStatus;
  createdAt: Date;
  storeVisualJob: { id: string; type: StoreVisualType; products: Array<{ product: { title: string } }> };
}): AssetItemWithKey {
  const titles = row.storeVisualJob.products.map((p) => p.product.title);
  return {
    id: row.id,
    kind: "STORE_VISUAL",
    subtype: row.storeVisualJob.type,
    scope: "STORE",
    jobId: row.storeVisualJob.id,
    productId: null,
    productTitle: titles.length > 0 ? titles.join(", ") : null,
    url: row.url,
    width: row.width,
    height: row.height,
    format: row.format,
    reviewStatus: row.reviewStatus,
    createdAt: row.createdAt,
    storageKey: row.storageKey,
  };
}
