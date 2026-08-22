# Billing & subscriptions

Covers the subscription-plan domain (`services/billing/`), the
`ShopSubscription`/`BillingEvent` Prisma models, the Shopify Billing API
integration, and `/app/billing`. See docs/usage.md for credit
reservation/consumption itself — this document is about which PLAN a
shop is on and how it gets there.

## Plan catalog

`services/billing/plans.ts`'s `PLANS: Record<PlanId, PlanDefinition>` —
**code constants, not database rows.** Same call this codebase already
made for the 6 built-in brand style presets
(`services/generation/brand-style-presets.ts`) and Product Intelligence's
category recommendations: plan tiers are app-controlled, versioned-in-code
data, not something a merchant (or even an admin UI) edits at runtime.
The only mutable, per-shop state is `ShopSubscription.planId` — which
`PlanId` a shop currently points at.

| Plan | Price | Credits/mo | Max outputs/generation | Store Visuals | Publishing |
|---|---|---|---|---|---|
| FREE | $0 | 40 | 1 | ✗ | ✗ |
| STARTER | $19 | 200 | 3 | ✓ | ✓ |
| PRO | $49 | 800 | 6 | ✓ | ✓ |
| BUSINESS | $149 | 2500 | 10 | ✓ | ✓ |

(See `PlanDefinition` in `services/billing/plans.ts` for the complete
field set — resolution limits, processing batch size, asset retention,
team seats, and the full `allowedOperations` list per plan.)

A shop with no `ShopSubscription` row is FREE by default (no backfill
needed on install — see the model's own schema comment).

## Provider decision: Shopify Billing, not a third-party processor

This is a Shopify **embedded app** charging Shopify **merchants** a
recurring subscription. The correct, App-Store-compliant mechanism for
that is Shopify's own Billing API
(`appSubscriptionCreate`/`appSubscriptionCancel`/
`currentAppInstallation.activeSubscriptions`) — not a third-party
processor like Stripe billing the merchant directly, which is not how
Shopify app billing works and would not pass App Store review.

Concretely, this decision was made because Shopify Billing:

- is gated by the app's **Partners/Dev Dashboard billing
  configuration**, not by OAuth `access_scopes` — adding
  `appSubscriptionCreate`/`appSubscriptionCancel` calls requests **no new
  scope** in `shopify.app.toml`, satisfying CLAUDE.md's "do not add
  Shopify write scopes" constraint for this pass by construction;
- reuses the exact same `executeAdminGraphQL`/`AdminGraphQLClient`
  transport `services/shopify/publish-media.server.ts` already built and
  tested (retries on THROTTLED, typed `ShopifyGraphQLError`) — no new
  HTTP client, no new dependency;
- is the mechanism Shopify itself documents for recurring
  merchant-facing app charges
  (https://shopify.dev/docs/apps/launch/billing).

All of it lives in one isolated file,
`services/billing/shopify-billing-provider.server.ts` — the second file
in this codebase (after `publish-media.server.ts`) allowed to define a
GraphQL mutation; `tests/unit/shopify-scope-safety.test.ts` enforces both
that allowlist and that no new scope was requested.

### Test mode

Every `appSubscriptionCreate` call sets `test: true` unless
`NODE_ENV === "production"` — Shopify's own documented mechanism for a
subscription that is confirmed and tracked normally but never actually
charges the merchant
(https://shopify.dev/docs/apps/launch/billing/test-charges). Every
environment except a real production deploy can exercise the full
subscription flow against a real Shopify dev store with zero risk of a
real charge.

## Data model

Two new Prisma models (migration
`20260822000001_add_billing_and_credit_costs`):

- **`ShopSubscription`** — one row per shop. `planId`, `status`
  (Shopify's own `AppSubscriptionStatus` vocabulary reused directly:
  PENDING/ACTIVE/CANCELLED/DECLINED/EXPIRED/FROZEN — see the model's
  schema comment for why this isn't a parallel vocabulary),
  `shopifySubscriptionId` (Shopify's AppSubscription GID, null until a
  real subscription exists), `currentPeriodStart`/`currentPeriodEnd`.
- **`BillingEvent`** — an idempotent, append-only audit trail. Every
  merchant-initiated action (request/cancel/change plan) and every
  webhook delivery is recorded here, keyed by a unique
  `idempotencyKey` — see "Idempotency" below.

`CreditReservation` (docs/usage.md) already existed; this pass added
`operationType` to it (so one reservation table genuinely serves all
four billable operation types) and renamed its `SETTLED` status to
`CONSUMED` to match this pass's requested REQUESTED/RESERVED/CONSUMED/
REFUNDED/FAILED vocabulary as closely as structurally sound (see
docs/usage.md "Requested vocabulary vs. what's actually persisted").

## Idempotency

`BillingEvent.idempotencyKey` is what makes both of these safe no-ops
instead of duplicates:

- **A redelivered `app_subscriptions/update` webhook.**
  `app/routes/webhooks.app_subscriptions.update.tsx` derives the key from
  `{subscriptionId}:{status}:{updatedAt}` — a genuinely new state change
  gets a new key; Shopify redelivering the identical payload produces the
  identical key, which `recordBillingEvent`'s `findUnique`-before-`create`
  detects and returns the existing row for, doing nothing further.
- **A merchant double-submitting "Upgrade."** `requestPlanChange`'s
  event key is derived from the newly-created Shopify subscription id
  itself — a genuine double-click still only calls
  `appSubscriptionCreate` twice (that part isn't idempotent — Shopify
  would create two pending subscriptions), but is otherwise out of scope
  for this pass's server-side idempotency guarantee, which covers OUR
  OWN state, not preventing a duplicate outbound API call from a fast
  double-click. The /app/billing UI disables the button while a request
  is in flight as the practical mitigation.

Webhook replay can't duplicate credits: `BillingEvent`'s idempotency
guard runs BEFORE `syncSubscriptionFromWebhook` touches
`ShopSubscription` at all, and — importantly — **plan/subscription state
never itself grants credits**; it only changes which `PlanDefinition`
`getPlan(shop)` resolves to, and the monthly allowance is stateless (see
docs/usage.md "Monthly renewal"). There is no "credit top-up" event a
webhook could double-fire.

## Entitlement resolution

`services/usage/entitlement.server.ts`'s `getPlan(shop)`:

```
ShopSubscription row exists AND status === "ACTIVE"?
  → that row's planId
  : → FREE (services/billing/plans.ts's DEFAULT_PLAN_ID)
```

This is intentionally a simplification — see docs/usage.md "Known
limitations" for what it does NOT do (preserve access through the end of
an already-paid period after cancellation).

## `/app/billing` UI

Shows: current plan name/status/credits-remaining/renewal date, a
Cancel-to-Free action (only when on a paid plan), and a grid of every
plan with Upgrade/Downgrade buttons. Selecting a paid plan POSTs
`change-plan`, which calls `requestPlanChange` and — on success —
redirects the TOP-LEVEL window (`window.top.location.href`, not the
embedded iframe) to Shopify's own hosted confirmation page, per
Shopify's documented requirement that billing confirmation cannot happen
inside the app's iframe. The merchant confirms there; Shopify redirects
back to `/app/billing` afterward, and the `app_subscriptions/update`
webhook (which may arrive before or after that redirect) is what
actually flips `ShopSubscription.status` to ACTIVE.

Selecting FREE (or the standalone Cancel button) never leaves the
embedded app at all — `cancelToFree` calls `appSubscriptionCancel`
in-place and updates local state immediately; there's nothing to
confirm on a $0 "subscription."

Every number on this page is read server-side in the loader — see
docs/usage.md "Security".

## Security

- Merchant-initiated billing actions (`requestPlanChange`/`cancelToFree`)
  use the per-request AUTHENTICATED `admin` client
  (`requireAdminContext`), never the offline/background client — a
  billing confirmation redirect only makes sense inside a live merchant
  request.
- The webhook route verifies HMAC/shop via `authenticate.webhook`
  (same as every other webhook handler in this codebase) before touching
  anything.
- `ShopSubscription`/`BillingEvent` are shop-scoped by their own `WHERE`
  clause throughout (no separate ownership check needed, same reasoning
  as every other repository).
- Never trust a client-supplied `planId` as authorization for
  anything — `requestPlanChange` validates it against
  `services/billing/plans.ts`'s real catalog and always creates a
  PENDING (not ACTIVE) row; only the verified webhook can ever move a
  subscription to ACTIVE.

## Known limitations

- **Cancelling mid-period doesn't preserve paid-for access through the
  period end** — see docs/usage.md "Known limitations".
- **A merchant double-clicking "Upgrade" can create two PENDING Shopify
  subscriptions** — Shopify's own confirmation flow means the merchant
  would need to actually confirm one on Shopify's hosted page; the
  second, unconfirmed one expires on Shopify's side. Not actively
  prevented client-side beyond disabling the button while a request is
  in flight.
- **`PlanDefinition.maxOutputsPerGeneration`/`maxProcessingBatchSize` are
  now enforced** (live-deployment pass) — `services/usage/entitlement.server.ts`'s
  `assertWithinOutputLimit`/`assertWithinBatchLimit`, checked at every
  request-side entry point BEFORE any job/batch is created or credits
  reserved: `services/generation/request-generation.server.ts`'s shared
  `createAndEnqueueGenerationJob` primitive (covers every generationType,
  including Creative Studio), `services/store-visuals/request-store-visual.server.ts`
  (reuses `maxOutputsPerGeneration` — the same "how many images does one
  job produce" concept), and both `services/processing/batch.server.ts`/
  `services/generation/batch.server.ts` (reuse `maxProcessingBatchSize` —
  the same "how many images does one batch operation touch" concept,
  deliberately not a second, generation-specific field). A request that
  exceeds its plan's limit is rejected outright (`PlanLimitExceededError`,
  "Upgrade your plan for a higher limit"), never silently clamped to a
  smaller count without telling the merchant.
- **`PlanDefinition.maxGenerationResolutionPx` is still NOT enforced** —
  `services/generation/build-input.ts` doesn't read a plan's resolution
  cap; every plan currently gets whatever resolution the provider itself
  defaults to for a given aspect ratio/quality tier (see
  docs/ai-pipeline.md). Flagging explicitly rather than leaving it to be
  discovered later — closing this gap needs the provider layer to accept
  an explicit max-dimension parameter per plan, not yet wired.
- **No proration, no invoices/transactions UI** — Shopify's Billing API
  exposes transaction history; this pass's `/app/billing` doesn't
  surface it (out of scope: "invoices/transactions if available" was
  read as "support the concept," which `getCurrentSubscription`'s
  existence satisfies at the provider layer — a dedicated invoices list
  UI is future work).
- **No team/multi-staff billing** — `PlanDefinition.teamSeats` exists as
  a stated number but this app has no multi-staff concept at all (one
  Shopify shop = one tenant throughout this codebase).
