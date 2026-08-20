# services/intelligence

Product Intelligence — the "understand the product before generating
anything" layer (Phase 2):

- `schema.ts` — `ProductIntelligenceSchema` (Zod), the strict, validated
  shape every provider's raw output must pass through before it's
  persisted or shown to a merchant.
- `category-recommendations.ts` — pure, data-driven category → generation
  recommendation lookup (asset types, model suitability, environments).
- `build-input.ts` — pure mapping: our synced `ShopifyProduct` (+ media) →
  `AnalyzeProductInput`.
- `stale.ts` — pure staleness detection (a READY profile whose product has
  since changed on Shopify).
- `provider.server.ts` — resolves which `AIProvider` to use (always
  `UnconfiguredAIProvider` today — no vendor selected yet — except the
  test-only deterministic seam).
- `deterministic-test-provider.server.ts` — test-only `AIProvider` double,
  never reachable outside `NODE_ENV=test`.
- `job.server.ts` / `queue.server.ts` — the `"product-intelligence"` BullMQ
  job payload/processor and its producer-side enqueue helper.
- `product-intelligence.server.ts` — the service entry point routes call
  (`requestProductAnalysis`, `getProductIntelligence`).

See docs/product-intelligence.md for the full architecture, schema, and
lifecycle. AI image generation itself is a later phase — see
docs/roadmap.md.
