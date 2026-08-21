# AI Assets — cross-domain asset library

## Purpose

By the end of Phase 7, a merchant's generated/processed imagery is
scattered across three independent domains — `GenerationResult`
(product cleanup/lifestyle/model shoot/banner/CTA), `ProcessingResult`
(background removal/enhance/resize), `StoreVisualResult` (homepage
hero/collection banner/store CTA) — each browsable only from its own
entry point (a product's detail page, a batch review page, a store
visual's own detail page). There was no single place to see everything
a shop has generated. `services/assets/asset-library.server.ts` +
`app/routes/app.assets.tsx` (nav: **AI Assets**) is that place.

Deliberately **not** a DAM (digital asset management) system: no
tagging, no albums, no bulk actions, no search-by-content. It answers
one question — "show me everything this shop has generated, newest
first, filterable by source and review status" — and links out to each
result's own domain page for anything more (Approve/Reject/Regenerate
stay where they already live; this page never duplicates them).

## Merge strategy — bounded fetch, not a raw SQL UNION

Three independent tables, no shared parent, no polymorphic Prisma
relation — `services/assets/asset-library.server.ts`'s `listAssetLibrary`
handles this with a normalized in-application merge rather than a
hand-written SQL `UNION`:

- **`kind` filter set** (Generation-only / Processing-only /
  StoreVisual-only): ordinary, exact single-table `skip`/`take`
  pagination against that one domain's `list*ResultsForShop` repository
  function. No approximation.
- **`kind` filter unset** (browsing everything): each of the three
  domains' `list*ResultsForShop` functions is called with a **bounded**
  fetch depth (`min(page * pageSize, MAX_FETCH_PER_SOURCE)` — currently
  300 — never "all of a shop's history," which is exactly the unbounded-
  retrieval pattern this was built to avoid). The results are merged and
  sorted by `createdAt` in application code, then sliced to the
  requested page.
- `total` is still an **exact** count in both cases — a `COUNT` per
  domain is cheap even though the fetch side is bounded, so pagination
  controls stay accurate regardless of how deep a merchant pages.
- **Known, accepted trade-off**: the merged ORDERING only stays exactly
  correct within the first `MAX_FETCH_PER_SOURCE` results per domain.
  Deep pagination — well beyond what a merchant realistically browses to
  in a "recent activity" list — can very rarely interleave slightly out
  of order across domains near that boundary. Documented here and in the
  source rather than silently approximate.

## `kind` doubles as "type" and "product/store scope"

Generation and Processing results are always product-scoped (`scope:
"PRODUCT"`, every row has a `productId`); StoreVisual results are always
store-scoped (`scope: "STORE"`). There is no case where the same `kind`
spans both scopes, so a separate scope selector would just be a less
specific version of the same filter — the UI exposes one "Source"
dropdown (All / Product generation / Product processing / Store visual),
not two.

A finer-grained subtype filter (the 9 `GenerationType`s / 6
`ImageOperation`s / 3 `StoreVisualType`s) is shown as a label on each row
(e.g. "Lifestyle scene", "Remove background", "Homepage hero") but is
**not** independently filterable this pass — 18 additional filter values
on a page whose entire purpose is staying simple would be over-building
a v1.

## Normalized shape

```ts
interface AssetItem {
  id: string;                    // the result row's own id
  kind: "GENERATION" | "PROCESSING" | "STORE_VISUAL";
  subtype: GenerationType | ImageOperation | StoreVisualType;
  scope: "PRODUCT" | "STORE";
  jobId: string;                 // links back to the owning domain's detail page
  productId: string | null;
  productTitle: string | null;   // StoreVisual: up to 3 featured products' titles, joined
  url: string | null;            // freshly re-signed — see below
  width, height, format: ... | null;
  reviewStatus: "PENDING" | "APPROVED" | "REJECTED";
  createdAt: Date;
}
```

`services/assets/types.ts` (NOT `.server.ts`) holds this shape plus
`ASSET_KINDS`/`ASSET_SCOPE_BY_KIND` — `app/routes/app.assets.tsx`'s
client-rendered component needs `ASSET_KINDS` at runtime to render the
Source filter's options, and React Router strips server-only code from a
route's `loader`/`action` but **not** from its other exports; a runtime
value the component body uses can't live in a `.server.ts` file (see
https://reactrouter.com/explanation/code-splitting#removal-of-server-code).
`services/assets/asset-library.server.ts` (the actual query/merge logic)
imports from `./types`, not the other way around, and re-exports the
constants for convenience.

## Fresh-signed URLs, no internal path exposure

Every `AssetItem.url` is produced by `lib/storage/resign.server.ts`'s
`resignResultUrls` — the same fresh-resigning-on-read fix applied
everywhere else (see docs/store-visuals.md "Signed URL freshness"). The
internal `storageKey` needed to resign is carried on an
`AssetItemWithKey` type used only inside the service, and stripped
before the public `AssetItem` is returned — `storageKey` never reaches
`app/routes/app.assets.tsx`'s loader, let alone the client.

## Route

`app/routes/app.assets.tsx` — loader reads `kind`/`status`/`page` query
params (an unrecognized `kind` value is silently ignored, not an error,
so a stale/malformed URL degrades to "show everything" rather than
crashing), calls `listAssetLibrary`, renders an `<s-table>` with a
thumbnail, type (linking to the result's own domain detail page),
source, review-status badge, and created date per row, plus Source/
Status filter selects and pagination.

## Testing

- **Unit**: none needed beyond what integration covers — the merge
  logic is inherently a database-query composition, tested at the
  integration level against real Postgres data across all three domains.
- **Integration**: `tests/integration/assets/asset-library.server.test.ts`
  (merge/newest-first ordering, no `storageKey` leak, `kind` filter
  exactness, status filter, tenant isolation, bounded pagination, invalid
  page clamping), `tests/integration/routes/app.assets-loader.test.ts`
  (route-level: empty state, merged listing, invalid `kind` query param
  handling, valid `kind` filter).
- **E2E**: `tests/e2e/store-visuals.spec.ts`'s "AI Assets — cross-domain
  library" scenarios — seed a product generation AND a store visual
  through their own real UIs, verify both appear newest-first on
  `/app/assets`, verify the Source filter narrows correctly, verify
  another shop's assets never appear.

## Explicitly deferred

- No tagging, albums, saved filters, bulk approve/reject, or
  search-by-content.
- No subtype filter (see "`kind` doubles as..." above).
- No CSV/export.
- Ordering beyond `MAX_FETCH_PER_SOURCE` per domain is best-effort, not
  guaranteed exact (see "Merge strategy" above) — acceptable for a
  "recent activity" view, not appropriate if this ever needs to become an
  audit-grade complete history export.
