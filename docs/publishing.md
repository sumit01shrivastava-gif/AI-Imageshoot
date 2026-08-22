# Publishing to Shopify

Publishing an approved, AI-generated/processed result back to a
merchant's Shopify product media gallery. Covers `services/publishing/`,
`services/shopify/publish-media.server.ts`, the `"publishing"` BullMQ
queue/worker, `/app/publishing`, and the `PublishControl` component
embedded on every domain's review page.

## Required scope: `write_products` — deliberately still NOT requested

The one Shopify Admin GraphQL WRITE this app makes anywhere is
`productCreateMedia`, which requires the `write_products` scope.
`shopify.app.toml`'s `[access_scopes]` still reads only `read_products`
(`tests/unit/shopify-scope-safety.test.ts` enforces this — see that
file's module doc comment).

This is intentional, not an oversight: adding a new OAuth write scope
forces every already-installed merchant to re-consent — a real,
user-facing, semi-irreversible change. CLAUDE.md has repeatedly
reaffirmed deferring this decision across several passes rather than
flipping it casually, most recently in the live-deployment pass (see
docs/production-deployment.md "Known limitations") because there is no
live merchant install available in this environment to verify the
publish flow actually works end-to-end once the scope is granted —
adding an unverified change to the single most sensitive scope boundary
in this app was judged worse than leaving it deferred one more pass.

**The mutation itself is fully implemented and correct** —
`services/shopify/publish-media.server.ts`'s `publishMediaToProduct`
speaks Shopify's real `productCreateMedia` contract. Today, every real
publish attempt against a real store fails with a genuine Shopify
permission error (the installed app's OAuth token has no product-write
grant) — surfaced to the merchant as a plain, honest message (see
"Error handling" below), never a silently-faked success. Turning
publishing on for real is a two-step, deliberate decision when you're
ready: (1) add `write_products` to `shopify.app.toml`'s
`[access_scopes]` and `.env.example`'s `SHOPIFY_SCOPES` default, (2)
have every already-installed merchant re-consent (Shopify prompts this
automatically on next app load once the scope changes) — update
`tests/unit/shopify-scope-safety.test.ts`'s assertions accordingly when
you do.

## Architecture

Publishing is its own domain (`services/publishing/`), not folded into
generation/processing/store-visuals — the same "a genuinely different
kind of request gets its own model/service" call this codebase has made
repeatedly (Phase 4's `ProcessingJob` vs. `GenerationJob`, Store
Visuals' own model family). A `PublishingJob` can point at a result from
ANY of the three other domains:

```
services/publishing/types.ts
  PUBLISHING_SOURCE_TYPES = ["GENERATION_RESULT", "PROCESSING_RESULT", "STORE_VISUAL_RESULT"]
```

`services/publishing/resolve-source.server.ts`'s `resolvePublishSource`
is the one place that knows how to load a result from any of the three,
tenant-checked, returning a normalized shape (`reviewStatus`,
`storageKey`, `candidateProducts`) regardless of which domain it came
from — everything downstream (`request-publish.server.ts`,
`job.server.ts`) works against that normalized shape, never against
three separately-typed result models.

```
Merchant clicks Publish on an APPROVED result (PublishControl component,
embedded on every domain's review page)
  → requestPublish(context, { sourceType, sourceResultId, targetProductId })
      → resolvePublishSource — tenant-checked, must be APPROVED,
        targetProductId must be one of the result's own candidateProducts
      → refuses if already SUCCEEDED (AlreadyPublishedError) or a job is
        already in flight (PublishInProgressError) — never double-publishes
      → creates a PublishingJob row (PENDING → QUEUED)
      → "publishing" BullMQ queue
                                          [returns to the merchant]
  ↓ (worker)
  → re-resolves the source FRESH (never trusts request-time state — a
    result could be un-approved or its product deleted in between)
  → storage.getSignedUrl(source.storageKey) — a time-limited, signed URL
    Shopify's own servers fetch the image FROM (never uploads raw bytes
    through this app's own request)
  → publishMediaToProduct(shop, { shopifyProductId, imageUrl, altText })
      → productCreateMedia via the OFFLINE/background admin client
        (unauthenticated.admin(shop) — no per-request session available
        from a worker process)
  → markSucceeded/markFailed
```

## Approval and publishing are separate concepts

Approving a result (`reviewStatus: APPROVED`) never automatically
triggers a publish — nothing in this codebase calls `requestPublish`
from an Approve action. A merchant explicitly chooses to publish,
separately, and explicitly chooses WHICH product it goes to (never
inferred) — `PublishControl`'s own UI enforces picking one of the
result's `candidateProducts` explicitly.

## Idempotency / double-publish prevention

`requestPublish` checks the most recent `PublishingJob` for the same
`(sourceType, sourceResultId)` before creating a new one:

- Already `SUCCEEDED` → `AlreadyPublishedError` (a merchant clicking
  Publish twice on an already-published result is a safe no-op error,
  not a duplicate Shopify media attachment).
- Currently `PENDING`/`QUEUED`/`PROCESSING` → `PublishInProgressError`.
- `FAILED`/`CANCELLED` → a normal new job is created — a merchant
  retrying after a failure is expected and correct.

## Error handling

| Condition | Merchant sees |
|---|---|
| No `write_products` scope (current state) | "This app doesn't have permission to publish images to your store yet. Contact the app developer." — no retry (`UnrecoverableError`, skips straight to FAILED; a missing scope will not fix itself between backoff attempts) |
| Result no longer approved (rejected/un-approved after the request) | "This result is no longer approved for publishing." |
| Source result/product deleted between request and worker run | "The result being published no longer exists." |
| Any other Shopify API failure | generic "Publishing failed. Please try again in a moment." — retried automatically per the queue's normal backoff |

Never exposed: the raw Shopify GraphQL error body, the OAuth token, or
any internal storage path.

## `/app/publishing`

A merchant-facing history page — every publish attempt across every
domain, most-recent-first, with status and (on success) a link to the
Shopify media that was created. `PublishControl` (embedded on every
review page — product detail, store visual detail, Creative Studio) is
the actual publish entry point; `/app/publishing` is the read-only
audit trail.

## Security

- `resolvePublishSource`/`findProductForShop` both re-verify shop
  ownership independently — a `targetProductId` is checked against BOTH
  the result's own `candidateProducts` AND a fresh, shop-scoped product
  lookup (defense in depth, not one check trusted transitively).
- The image Shopify fetches from is always a signed, time-limited URL
  from this app's own storage — never a client-supplied URL, never a
  permanently-public object.
- The worker uses the OFFLINE/background admin client
  (`unauthenticated.admin(shop)`), which throws cleanly if the shop has
  no stored session (e.g. the app was since uninstalled) — handled the
  same way as any other terminal failure, never crashes the worker
  process.

## Known limitations

- **Not live** — see "Required scope" above.
- **No bulk/batch publish** — one result, one product, one explicit
  merchant action at a time; no "publish everything approved" flow.
- **No un-publish/delete-from-Shopify action** — this app only ever
  ADDS media via `productCreateMedia`; removing something it published
  is a manual action in Shopify admin today.
