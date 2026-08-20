# Roadmap

Phases are defined and sequenced by whoever is directing this project, one
at a time. This document is a best-effort sketch of what's ahead, kept for
context — it is **not an implementation queue**. Do not build a future
phase's item because it's listed here; wait to be told. See CLAUDE.md
"Incremental development".

## Phase 0 — Foundation (this phase)

Shopify app scaffold, environment/config, Prisma + Postgres foundation
(`Session` only), AI provider abstraction, storage abstraction, queue
foundation, domain-separated project structure, security foundation,
this documentation set, and a verified (typecheck/lint/test/build green)
committed baseline.

## Phase 1+ (indicative only, unscoped)

Roughly in the order the product overview in CLAUDE.md implies, though
the actual next phase is whatever is explicitly requested next:

- Shopify product/catalog synchronization (Admin GraphQL queries, sync
  strategy, `ProductAsset`/`ProductIdentity` models)
- Product + image selection UI
- Background removal / replacement
- Image cleanup and enhancement
- Lifestyle image generation
- AI-model image generation
- Multiple aspect ratios, batch generation
- Review/approval workflow, asset versioning (`MediaAsset`/`MediaVersion`)
- Publishing approved assets back to Shopify (`Publication`)
- AI usage tracking and credits (`UsageRecord`/`CreditBalance`/`CreditTransaction`)
- Billing/subscription plans
- Brand style and model presets (`BrandStyle`/`ModelPreset`)

Each of these will get its own scoped instructions, its own database
models introduced only when needed, and its own docs updates when it
lands.
