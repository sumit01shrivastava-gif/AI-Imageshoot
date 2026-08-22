# Usage & credit entitlement

This document covers two related but distinct things:

1. **The usage ledger** (`services/usage/usage-accounting.server.ts`,
   `UsageEvent`) — a permanent audit record of every AI operation that
   ran, whether it succeeded or failed. Merchant-visible at `/app/usage`.
2. **The credit entitlement system** (`services/usage/entitlement.server.ts`,
   `CreditReservation`) — the live gate that decides whether a NEW
   operation is allowed to start at all, and reserves/settles/refunds a
   credit hold around it. Merchant-visible at `/app/billing`
   (docs/billing.md).

They share one thing (both are keyed by the same job id) but serve
different purposes: the ledger is written AFTER an operation finishes
(informational, append-only); entitlement is checked BEFORE an operation
starts (a real gate that can block a request) and updated at the
operation's terminal outcome.

## Credit lifecycle

Every billable request follows this sequence:

```
1. checkEntitlement(shop, operationType, requiredCredits)
     → reads the shop's current plan (services/billing/plans.ts) and its
       usage so far this calendar month
     → { allowed: false, reason: "OPERATION_NOT_ON_PLAN" }  — the plan
       doesn't include this capability at all (e.g. FREE + store visuals)
     → { allowed: false, reason: "INSUFFICIENT_CREDITS" }   — the plan
       allows it, but not enough credit remains this month
     → { allowed: true }                                    — proceed
2. reserveCredits(shop, jobId, operationType, amount)
     → creates a RESERVED CreditReservation row, keyed uniquely on jobId
3. The job is created and enqueued — never before step 2 succeeds
     (Part 9: "a generation request must never reach the queue if
     credit reservation fails")
4. The worker runs the job
5a. On success: the reservation moves RESERVED → CONSUMED
5b. On failure (the job's FINAL attempt, not an intermediate retry):
     the reservation moves RESERVED → REFUNDED
```

Every one of these steps happens server-side. Nothing about a plan,
credit balance, or cost is ever trusted from the client — see "Security"
below.

### Requested vocabulary vs. what's actually persisted

The originating request asked for five named states: REQUESTED,
RESERVED, CONSUMED, REFUNDED, FAILED. Only three are persisted as a
`CreditReservationStatus` value — the other two are real but
**transient/conceptual**, not separate rows:

- **REQUESTED** — the moment `checkEntitlement` runs. Never persisted;
  if it's denied, nothing is written at all (there is no
  "REQUESTED-but-denied" row to clean up).
- **RESERVED** — persisted. A hold exists and counts against the shop's
  monthly allowance.
- **CONSUMED** — persisted. The operation succeeded; the hold is final.
- **REFUNDED** — persisted. The operation failed (or was superseded);
  the credit is given back.
- **FAILED** — conceptually the same event as "the job's terminal
  failure," which is exactly what triggers a REFUND. There is
  deliberately no separate "FAILED" reservation state distinct from
  REFUNDED — a failed operation never permanently holds a credit, so
  "failed" and "refunded" are the same outcome from the ledger's
  perspective. (The *usage ledger*, `UsageEvent.status`, does have its
  own independent `FAILED` value — that's a different, purely
  informational record of what happened, not a credit state.)

This mapping is a deliberate simplification, not an oversight: it keeps
`CreditReservationStatus` a real state machine with no unreachable states
(REQUESTED never has a row to be in; FAILED and REFUNDED never diverge)
rather than inventing states that would immediately alias one another.

### Idempotency (no double-charging)

- **A retried job never double-charges.** `createReservation` is an
  `upsert` keyed on `CreditReservation.jobId` (`@unique`) — calling it
  twice for the same job id returns the existing row untouched.
  `settleReservation`/`refundReservation` are conditional updates
  (`WHERE status = 'RESERVED'`) — calling either twice affects zero rows
  the second time. A BullMQ retry re-running the same job's processor
  therefore can't create a second reservation or double-resolve one.
- **A regeneration is a new billable operation.** Every domain's
  "Regenerate" action creates a brand-new job row with a brand-new id
  (this codebase's existing, pre-billing history/versioning mechanism —
  see docs/generation.md) — so it gets its own, independent
  reservation. This is intentional: regenerating IS a new request for
  a new image.
- **Product Intelligence's queue dedup gets special handling.** Unlike
  every other domain, `"product-intelligence"` jobs are keyed
  deterministically by `(shop, productId)` and a duplicate in-flight
  request collapses onto the SAME BullMQ job (see
  `services/intelligence/job.server.ts`'s module doc comment) — reusing
  that same deterministic id as the reservation's jobId would make every
  re-analysis silently collide with (and no-op against) the first one's
  reservation. `requestProductAnalysis` avoids this with a synthetic
  per-request `creditReservationId` (a fresh UUID, threaded through the
  job payload) and only reserves credits at all when the product isn't
  already PENDING/PROCESSING (a narrow, accepted race is possible here —
  see "Known limitations").

### Rollback on job-creation failure

Every request-side entry point (`createAndEnqueueGenerationJob`,
`createAndEnqueueProcessingJob`, `requestStoreVisual`,
`requestProductAnalysis`) wraps the sequence from credit reservation
through `markQueued`/enqueue in one rollback boundary: if ANYTHING in
that sequence fails (a transient DB error reserving credits, a
`beforeEnqueue` hook failing, a `markQueued`/enqueue failure), the code
best-effort refunds whatever reservation exists (`refundReservation`'s
conditional update is a harmless no-op if none was actually created yet)
and marks the job/profile row FAILED, then rethrows the original error.
Closes a genuine correctness gap found during the final production
-integration audit: without this, a job row could exist with a
permanently-RESERVED credit that no worker would ever run to
settle/refund, since the job was never actually enqueued. See
`tests/integration/{generation,processing,store-visuals,intelligence}/request-*-rollback.test.ts`
for the regression coverage (each mocks only that domain's queue module,
against real Postgres).

### Ordering: credit resolution before the terminal status write

Each domain's worker (`job.server.ts`) settles/refunds a job's
reservation (`settleReservation`/`refundReservation`, or the generation
-domain's `resolveGenerationCredits` wrapper) BEFORE writing the job's
terminal `SUCCEEDED`/`FAILED` status (`markSucceeded`/`markFailed`) —
deliberately, not after. `markSucceeded`/`markFailed` is what makes a
job's outcome externally OBSERVABLE (a route/test polling job status, or
a merchant's page reflecting a completed generation); if credit
resolution ran after that write, a caller could observe a terminal
status while the reservation was still `RESERVED` a moment longer. This
was not theoretical — it was found as a real, reproducible-under-load
test flake (`tests/integration/creative-studio/session.test.ts`'s
"refunds the reservation when generation fails" test) during this same
audit pass, confirmed absent on a clean checkout and consistently
present once the full suite's parallel Postgres/Redis load was heavy
enough to widen the window. Fixed uniformly across generation,
processing, and store-visuals; the Product Intelligence domain's
`saveResult` is a deliberate exception — see that call site's own doc
comment in `services/intelligence/job.server.ts` for why reordering it
would trade this narrow read race for a worse one (settling a credit for
a write that then fails).

## Credit cost rule

`services/usage/credit-costs.ts`'s `getCreditCost`:

```
cost = perOutputCost(operationType, mode) × max(1, outputCount)
```

- **PRODUCT_ANALYSIS** is a flat per-operation cost — `outputCount`
  doesn't apply (a profile is one thing, not N outputs).
- **IMAGE_PROCESSING** is a flat per-job cost.
- **STORE_VISUAL_GENERATION** is charged per output.
- **IMAGE_GENERATION** is priced by `GenerationMode`
  (`services/ai/types.ts`): `IMAGE_TO_IMAGE`/`IMAGE_EDIT` cost more per
  output than `TEXT_TO_IMAGE`/`VARIATION` — editing against a real
  vendor is a genuinely more expensive class of request than a fresh
  generation. Every pre-Creative-Studio generationType never sets
  `mode`, so it falls back to the same rate as `TEXT_TO_IMAGE`.

**Multi-output rule**: a request for N outputs (e.g. "give me 3
variations") is billed as **one logical reservation for the full
requested count**, made BEFORE the job runs. It is never charged
incrementally as each of the N results completes — if the job fails
outright, the entire reservation is refunded; there is no partial-refund
concept for "2 of 3 outputs actually rendered" (that scenario doesn't
occur in this pipeline's data model either — a `GenerationJob` is
all-or-nothing SUCCEEDED/FAILED, see docs/generation.md "Storage").

## Entitlement API

`services/usage/entitlement.server.ts` — the public surface every domain
uses:

- `getPlan(shop)` → the shop's resolved `PlanDefinition` (services/billing/plans.ts)
- `getMonthlyAllowance(shop)` → `getPlan(shop).monthlyCredits`
- `canUseOperation(shop, operationType)` → is this operation on the plan at all
- `getRemainingCredits(shop)` → allowance minus this month's usage (RESERVED + CONSUMED)
- `checkEntitlement(context, operationType, requiredCredits)` → the full `EntitlementCheck`
- `reserveCredits(context, jobId, operationType, amount)`
- `settleGenerationCredits` / `refundGenerationCredits` (generic — resolve any reservation, not IMAGE_GENERATION-specific despite the name kept for the Creative Studio's original call sites)

Every one of the four billable domains now goes through this same path
before enqueueing:

| Domain | Entry point | operationType |
|---|---|---|
| Creative Studio | `services/creative-studio/session.server.ts`'s `sendCreativeMessage` (checks/reserves BEFORE building the plan or writing any chat message, then passes its own reservation through `createAndEnqueueGenerationJob`'s `beforeEnqueue` hook) | `IMAGE_GENERATION` |
| Every other generationType (PRODUCT_CLEANUP/LIFESTYLE/MODEL_SHOOT/BANNER/CTA, single or batch) | `services/generation/request-generation.server.ts`'s shared `createAndEnqueueGenerationJob` primitive itself — checks/reserves right after building the plan (so the cost can be mode/outputCount-aware), skipped only when `creativeSessionId` is set (Creative Studio already reserved) to avoid double-charging | `IMAGE_GENERATION` |
| Image processing | `services/processing/request-processing.server.ts`'s `createAndEnqueueProcessingJob` | `IMAGE_PROCESSING` |
| Store visuals | `services/store-visuals/request-store-visual.server.ts`'s `requestStoreVisual` | `STORE_VISUAL_GENERATION` |
| Product analysis | `services/intelligence/product-intelligence.server.ts`'s `requestProductAnalysis` | `PRODUCT_ANALYSIS` |

## Monthly renewal

There is **no explicit renewal job, no persisted "current period usage"
counter, and no cron**. `getMonthlyCreditsUsed(shop, monthStart)`
(`db/repositories/credit-reservation.repository.ts`) sums reservations
`WHERE createdAt >= monthStart`, where `monthStart` is computed fresh on
every call as "the 1st of the current UTC calendar month"
(`entitlement.server.ts`'s `currentMonthStart`). The allowance therefore
resets automatically and deterministically the instant the calendar
rolls over — there is nothing to run, nothing that can fail to run, and
nothing that can double-run. This satisfies "monthly credit renewal must
be deterministic and idempotent" by construction rather than by adding
stateful renewal logic that could itself have a bug.

(This does mean a plan change or Shopify subscription period boundary
that doesn't align with the calendar month isn't separately tracked —
see "Known limitations".)

## Security

- **Never trust a client-supplied credit amount, plan, or entitlement.**
  Every number `/app/billing` and `/app/creative/:sessionId` display is
  read server-side, in the loader, from `getPlan`/`getRemainingCredits`/
  `checkEntitlement` — never computed or passed through from a form
  field or query param.
- **Tenant isolation**: every repository function here is shop-scoped by
  its own `WHERE shop = ...` clause (mirrors every other repository in
  this codebase — see CLAUDE.md "Database rules"). A `CreditReservation`
  or `ShopSubscription` row can never be read or mutated across shops.
- **A route action can only ever spend the AUTHENTICATED shop's own
  credits** — `context.shop` comes from `requireAdminContext`, never
  from client input.

## Known limitations

- **A narrow race between check and reserve.** `checkEntitlement` and
  `reserveCredits` are two sequential calls, not one atomic
  check-and-hold. Two concurrent requests that each individually pass
  the check could, in a sufficiently narrow window, both reserve against
  the same remaining balance. Accepted for this pass — the practical
  blast radius is "a shop's usage this month reads slightly over its
  allowance by at most one request's worth," never a security issue or a
  double free/negative-cost scenario.
- **Cancelling mid-period doesn't preserve paid-for access.**
  `services/usage/entitlement.server.ts`'s `resolvePlanId` falls back to
  FREE the instant a `ShopSubscription.status` leaves ACTIVE — a real
  Shopify merchant billing product typically keeps a cancelled
  subscription's plan active through the END of its already-paid
  period. Documented here rather than silently assumed; fixing this
  would mean tracking `currentPeriodEnd` in the entitlement check, not
  just `status`.
- **Product Intelligence's collapsed-duplicate detection is a
  check-then-enqueue race, not a lock.** See "Idempotency" above.
- **No automatic monthly-usage-exceeded notification** — a shop
  discovers it's out of credits when a request is denied, not via a
  proactive alert.
- **Retention policy (`PlanDefinition.assetRetentionDays`) is a stated
  policy number, not enforced.** No job deletes assets past their plan's
  retention window — see docs/billing.md "Known limitations".
