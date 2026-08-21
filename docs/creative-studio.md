# Creative Studio

A conversational, ChatGPT/Canva-style image creation/editing workspace
for one product at a time — `services/creative-studio/`,
`/app/creative/:sessionId`. Built entirely on top of the existing
`GenerationJob`/`GenerationResult` pipeline (Phase 3–7) rather than a
second, parallel generation system: every conversational turn produces a
real `GenerationJob` with `generationType: "CREATIVE_STUDIO"`, going
through the exact same queue, worker, provider resolver, storage
abstraction, and review lifecycle every other generation type already
uses.

## Architecture

```
Merchant message (chat input, or a canned instruction from a UI button
like "Regenerate"/"Create variation")
  → services/creative-studio/session.server.ts's sendCreativeMessage
      → services/ai's IntentParsingProvider.parseIntent
          (services/ai/heuristic-intent-parser.ts by default — see
           "Intent model" below)
      → intent-schema.ts's parseParsedIntent (validates the raw output —
         "reject malformed provider output", same as every other
         provider in this codebase)
      → creative-context.ts's resolveTargetResult (resolves an ordinal
         reference like "the second one" against real candidate results)
      → services/usage/entitlement.server.ts's checkGenerationEntitlement
      → plan-builder.ts's buildCreativeGenerationPlan
          (identity-constraints.ts's buildIdentityConstraints — Part 4's
           structural preservation split)
      → services/generation/request-generation.server.ts's
         createAndEnqueueGenerationJob (planOverride + creativeSessionId
         + a beforeEnqueue hook that reserves credits)
      → GenerationJob row (PENDING → QUEUED), the "generation" BullMQ
         queue (unchanged — no new queue)
      → two CreativeMessage rows persisted (USER + ASSISTANT)
                                          [returns to the merchant]
      ↓ (worker process, services/generation/job.server.ts — unchanged
         queue wiring, with a few `creativeSessionId`-gated additions:
         credit settle/refund, and linking the first result as the
         session's new current result)
  → services/ai's ImageGenerationProvider.generateImage (deterministic
     test provider in dev/test; UnconfiguredImageGenerationProvider
     otherwise — unchanged resolver)
  → StorageProvider.upload → GenerationResult row(s)
```

Nothing about the underlying `GenerationJob`/`GenerationResult` pipeline,
the `"generation"` queue, the provider resolver, or the storage
abstraction changed to support this — the Creative Studio's entire job is
turning a conversation into a `GenerationPlan`, and one small, additive
extension to the shared job-creation primitive (see "Reuse, not a second
pipeline" below).

## Session lifecycle

One `CreativeSession` row represents an ongoing conversation about one
product's imagery — deliberately **not** one row per message (that's
what `CreativeMessage` is for). "Product → Creative Session → multiple
instructions → multiple generated versions" is the whole point of this
model existing separately from `GenerationJob`.

- `productId` — mandatory; every session is scoped to one product.
- `sourceType` (`PRODUCT_IMAGE` | `GENERATION_RESULT` | `PROCESSING_RESULT`
  | `STORE_VISUAL_RESULT`) + `sourceResultId` — how the session started:
  fresh from the product's own Shopify-hosted images ("Create with AI"),
  or continuing from an existing result ("Continue editing" / "Open in
  Creative Studio" — see "Routing" below). `sourceResultId` is a **soft
  reference** (a plain string, no Prisma FK) into whichever domain's
  result table `sourceType` names — the same pattern already established
  by `PublishingJob.sourceResultId`/`sourceType` and
  `UsageEvent.jobId`/`operationType` (Prisma has no polymorphic
  relation).
- `currentResultId` — the canvas' current working image. A soft
  reference to a `GenerationResult.id`. Set automatically the first time
  a session-owned job succeeds (`services/generation/job.server.ts`'s
  `setInitialCreativeSessionResult`, gated on `creativeSessionId !==
  null`), and updated whenever the merchant explicitly picks a different
  variation (`selectCreativeResult` — "Use this") or references one by
  ordinal in a message ("use the second one").
- `status` (`ACTIVE` | `ARCHIVED`) — not surfaced in the UI yet; exists
  so a future "archive this session" action doesn't need a schema
  change.

`CreativeMessage` — one row per conversation turn (both the merchant's
own message and the assistant's reply), `role` (`USER`/`ASSISTANT`/
`SYSTEM`), `content`, `intent` (the validated `ParsedIntent` JSON, USER
messages only), and a soft reference to the `GenerationJob` the message
triggered/reports on.

## Intent model

Part 3's structured-interpretation-layer requirement. A merchant's raw
message is **never** concatenated into a provider prompt — it's first
resolved to a validated `ParsedIntent`
(`services/creative-studio/intent-schema.ts`), and the prompt is
synthesized from THAT structure (`plan-builder.ts`'s
`synthesizeCreativePrompt`), the same "structured fields → synthesized
prompt" discipline `services/generation/build-plan.ts` already applies
to every pre-existing generationType.

```ts
interface ParsedIntent {
  intent: CreativeIntentValue;   // EDIT_BACKGROUND, CHANGE_SCENE, CHANGE_LIGHTING,
                                  // CHANGE_CAMERA, CHANGE_COMPOSITION, ADD_MODEL,
                                  // CHANGE_MODEL, CHANGE_PROPS, CHANGE_COLOR,
                                  // CREATE_LIFESTYLE, CREATE_MARKETPLACE, CREATE_SOCIAL,
                                  // CREATE_BANNER, REMOVE_ELEMENT, ADD_ELEMENT, UPSCALE,
                                  // VARIATION, REGENERATE, MULTI_VARIATION
  mode: GenerationModeValue;     // TEXT_TO_IMAGE | IMAGE_TO_IMAGE | IMAGE_EDIT | VARIATION
  scene, style, lighting, composition, camera, colorDirection,
  addElements, removeElements,
  variationCount: number;
  targetResultReference: string | null;  // a raw ordinal token, e.g. "second" — see below
  preserveHints: string[];               // supplementary only, see "Identity preservation"
  changeSummary: string;                 // machine-generated, seeds the prompt
  confidence: number;
}
```

**Provider abstraction** (`IntentParsingProvider`, `services/ai/types.ts`):
`parseIntent(input): Promise<ParsedIntentRawOutput>`, validated by
`parseParsedIntent` before anything trusts it — the same "reject
malformed provider output" gate every other provider's output goes
through. This is its own interface, not folded into `AIProvider`/
`ImageGenerationProvider`: parsing a sentence and generating a
photorealistic image are unrelated capabilities that may end up backed
by entirely different vendors.

**The default implementation is real, not a placeholder** —
`services/ai/heuristic-intent-parser.ts`'s `HeuristicIntentParser` is a
deliberate, honest departure from every other provider in this
codebase's "`Unconfigured*` until a real vendor is wired up" convention.
It's a rule-based (keyword/pattern-matching) classifier, always
available, never gated behind `NODE_ENV === "test"`. The reasoning: the
Creative Studio's entire point is the conversational interaction — if
intent parsing only ever threw "not configured" outside tests, the
feature would be unusable in production with zero AI vendor credentials
configured, defeating the point of building it. Image *generation*
itself is unaffected by this — it still goes through the unchanged
`getConfiguredImageGenerationProvider()` resolver, honestly failing with
"Image generation isn't configured for this store yet" when no vendor is
set, exactly like every other generationType already does.

**Honest limitation of the heuristic parser itself**: it is not a real
language model. It correctly categorizes common, plainly-worded
ecommerce photography requests via keyword/pattern matching (see the
classifier's rule table in that file); it does not understand novel
phrasing, negation nuance, or genuinely ambiguous instructions the way a
real LLM-backed `IntentParsingProvider` does.

**A real-LLM implementation now exists** —
`services/ai/production-intent-parser.server.ts`'s
`ProductionIntentParsingProvider`, following the same "no vendor SDK
installed, a documented JSON contract instead" approach as
`production-image-generation-provider.server.ts`
(`POST {AI_PROVIDER_BASE_URL}/v1/intent/parse`, reusing the same
`AI_PROVIDER_BASE_URL`/`AI_PROVIDER_API_KEY`/`AI_PROVIDER_MODEL` env vars
— intent parsing is a capability of the same configured provider, not a
second vendor). `services/creative-studio/provider.server.ts`'s resolver
selects it — wrapped in `FallbackIntentParser`, which falls back to the
heuristic parser on ANY failure (network, timeout, malformed output) so
the conversational feature never goes down because a real LLM endpoint
is having a bad day — whenever those env vars are configured; the
heuristic parser remains the deterministic default (and the only thing
tests ever exercise, since tests never set those vars — see CLAUDE.md
"Never make a real AI API call from a test"). This satisfies Part 3's
"introduce a provider abstraction for intent understanding that can use
a real LLM when configured, while retaining the deterministic/heuristic
implementation as a fallback."

## Creative context (Part 8)

The session does **not** send its raw conversation history to the intent
parser or the image provider — that would be unbounded and
non-deterministic. Instead, `services/creative-studio/creative-context.ts`'s
`buildCreativeContext` derives a small, bounded structure fresh on every
request from already-persisted rows:

```ts
interface CreativeContext {
  hasCurrentResult: boolean;
  currentImageUrl: string | null;
  selectedResultId: string | null;
  activeScene: string | null;       // read back from the current result's
  activeStyle: string[];            // own GenerationJob.plan.creativeIntent —
  activeLighting: string | null;    // "make it brighter" only changes
  activeComposition: string | null; // lighting; everything else persists forward
  previousInstructions: string[];   // last 5 USER messages' raw text — light
                                     // continuity only, never sent to the image
                                     // provider as prompt text
  candidateResults: Array<{ id: string; ordinal: number; url: string | null }>;
}
```

`resolveTargetResult(context, targetResultReference)` is the stateful
half of reference resolution the parser deliberately doesn't do itself:
it resolves a raw ordinal token ("second", "last", "previous") against
`candidateResults` (the latest job's own outputs). "Previous" means "the
one before whichever is currently selected." Returns `null` (never
guesses) for an out-of-range ordinal or when nothing exists to resolve
against.

## Identity preservation (Part 4)

**The product is the immutable subject.** This is structural, not just
prose: `services/creative-studio/identity-constraints.ts`'s
`buildIdentityConstraints` derives an explicit, non-negotiable
preservation set from Product Intelligence's own `IdentityAnchors` —
category, shape, material, primary color, construction details,
distinctive hardware, branding — **every single request**, whether or
not the merchant mentioned preservation at all. `ParsedIntent.preserveHints`
(the parser noticing "keep it exactly the same") is supplementary only —
never the only thing standing between a request and the product being
redesigned.

The generation plan keeps "what MAY change" and "what must NOT change"
as two separate sub-objects (`services/generation/schema.ts`'s
`CreativeStudioPlanSchema`):

```ts
creativeIntent: {
  intent, mode,
  creative: { scene, style, lighting, composition, camera, colorDirection,
              addElements, removeElements },      // MAY change
  identityConstraints: { immutable: string[], instruction: string },  // must NOT
  creativeSessionId, rawInstruction,               // traceability only
}
```

The synthesized prompt always appends `identityConstraints.instruction`
— an itemized "do not redesign it, invent missing components, alter its
shape/packaging/logos/labels/material/color..." sentence built from the
real anchors, never invented.

### Creative overrides — explicit, structured exceptions (Part 2)

"Make the bottle black" is a deliberate exception to identity
preservation, not a violation of it: the merchant explicitly asked for
one specific, non-critical attribute (color, or material) to change.
This is handled structurally, never by string-editing the
`identityConstraints.instruction` sentence after the fact:

- `ParsedIntent.attributeOverrides: { color, material }`
  (`services/creative-studio/intent-schema.ts`) — a narrow, named field
  set, populated by the intent parser (the heuristic parser recognizes
  "make the X black"/"make it out of wood"-shaped phrasing;
  `services/ai/heuristic-intent-parser.ts`'s `extractAttributeOverrides`).
- `buildIdentityConstraints(anchors, productName, overrides)`
  (`services/creative-studio/identity-constraints.ts`) EXCLUDES an
  overridden attribute from the `immutable` list and appends an explicit
  "The merchant has explicitly requested the following change, which is
  permitted: color → black. Every other aspect of the product must
  remain exactly as shown." clause — naming exactly what changed, never
  silently dropping the color/material line and leaving the reader to
  guess why.
- `plan-builder.ts`'s `synthesizeCreativePrompt` also folds the override
  into the visible prompt text itself ("...the handbag recolored to
  black..."), not just the identity-constraints sentence.

Every OTHER anchor (shape, construction, hardware, branding) stays fully
immutable regardless of an override — only the two explicitly-named,
explicitly-requested fields are ever exempted.

## Image-to-image flow (Part 5)

`GenerateImageInput` (`services/ai/types.ts`) gained two small, additive
fields — absent for every pre-existing generationType, always set for
Creative Studio:

- `mode?: "TEXT_TO_IMAGE" | "IMAGE_TO_IMAGE" | "IMAGE_EDIT" | "VARIATION"`
- `referenceImages?: Array<{ url: string; role: "product_original" |
  "previous_result" | "style_reference" }>`

`sourceImages` always still carries the **original** Shopify-hosted
product image(s) — even on a follow-up edit, the provider is grounded
against the true original, not just the intermediate result.
`referenceImages` carries the specific prior `GenerationResult`'s signed
URL being edited forward from, when the mode calls for it. A provider
that doesn't support multi-reference editing may ignore `referenceImages`
and fall back to `sourceImages` + the prompt alone — this is an
additive contract extension, not a requirement every provider must
implement.

**Every conversational turn is a new `GenerationJob`/`GenerationResult`
— never an overwrite.** The merchant can always return to any previous
version (the version thumbnails on the canvas, or any prior job in the
session's history).

## Reuse, not a second pipeline

The one deliberate extension point in the shared primitive
(`services/generation/request-generation.server.ts`'s
`createAndEnqueueGenerationJob`):

- `planOverride?: GenerationPlan` — skips `buildGenerationPlan` (and the
  intelligence/preset lookups it needs) entirely, using an
  already-built, already-validated plan as-is. The Creative Studio's
  input shape (a conversational instruction + resolved session context)
  doesn't fit `buildGenerationPlan`'s per-generationType branches, but
  the resulting job/queue/worker/storage pipeline is identical either
  way.
- `creativeSessionId?: string` — sets `GenerationJob.creativeSessionId`
  (`SetNull` on the session's own deletion — a generated image an
  approved/published result must never vanish just because its
  originating conversation was deleted).
- `beforeEnqueue?: (jobId: string) => Promise<void>` — runs after the
  `GenerationJob` row is created but before it's marked QUEUED/enqueued,
  the one safe window to do something keyed on the real job id before a
  worker could possibly start processing it. The Creative Studio uses
  this to reserve credits; every other generationType passes nothing and
  is completely unaffected.

## Credit lifecycle (Part 9, superseded/completed — see docs/usage.md and docs/billing.md)

**This section originally described a flat, plan-less "development
credit allowance." A real plan/subscription/billing system now exists —
see docs/usage.md (entitlement, credit costs, the reserve/settle/refund
lifecycle in full detail) and docs/billing.md (plans, Shopify Billing
integration, `/app/billing`).** What follows is a short pointer, kept
here so this document's own "Credit lifecycle" heading still resolves to
something useful.

`services/usage/entitlement.server.ts`, backed by `CreditReservation`
(now with an `operationType` column shared across all four billable
domains, not Creative-Studio-specific) — deliberately separate from
`services/usage/usage-accounting.server.ts`'s `UsageEvent` audit ledger
(that's a record of what already happened; this is a live gate on what's
allowed to happen next):

```
checkGenerationEntitlement(context, requiredCredits)   — IMAGE_GENERATION-specific wrapper
  → { allowed, limit, used, available, required, operationType, reason? }
      (limit: the shop's real resolved plan — services/billing/plans.ts,
       via ShopSubscription; used: CONSUMED + still-outstanding RESERVED
       holds this calendar month)
reserveGenerationCredits(context, jobId, amount)
  → idempotent upsert on jobId (CreditReservation.jobId is @unique) —
    a retried/duplicate reservation for the same job is a safe no-op
settleGenerationCredits(context, jobId)   — called on SUCCEEDED (RESERVED → CONSUMED)
refundGenerationCredits(context, jobId)   — called on FAILED, final attempt (RESERVED → REFUNDED)
```

Cost is now mode-aware — an IMAGE_TO_IMAGE/IMAGE_EDIT request costs more
per output than a fresh TEXT_TO_IMAGE one (`services/usage/credit-costs.ts`,
docs/usage.md "Credit cost rule") — rather than a flat 1 credit per
request.

**Every generationType is now credit-gated**, not just Creative Studio:
`services/generation/request-generation.server.ts`'s shared
`createAndEnqueueGenerationJob` primitive checks/reserves for every
generationType EXCEPT when `creativeSessionId` is set (Creative Studio
already reserved its own credits earlier, before writing any chat
message — reserving again here would double-charge it). See docs/usage.md's
domain table for the complete picture across all four operation types.

**Known limitation** (unchanged): `checkEntitlement`/`checkGenerationEntitlement`
and `reserveCredits`/`reserveGenerationCredits` are two distinct,
sequential calls, not one atomic operation — a narrow race between them
is an accepted limitation, documented in docs/usage.md "Known
limitations".

## Generation status (Part 10)

The chat surfaces discrete, honest status phrases derived from the
existing `GenerationStatus` lifecycle — never a fake progress
percentage:

| `GenerationJob.status` | Phrase shown |
|---|---|
| `PENDING` / `QUEUED` | "Understanding your request…" |
| `PROCESSING` | "Creating your image…" / "Generating N variations…" |
| `SUCCEEDED` | "Your images are ready." |
| `FAILED` | (the job's own merchant-safe `errorMessage`, in a banner) |

## Error handling (Part 11)

| Condition | Merchant sees |
|---|---|
| Empty message | "Message cannot be empty." |
| Product not analyzed | "This product must be analyzed (Product Intelligence) before using the Creative Studio." |
| No source image | "This product has no image to start from." |
| Insufficient credits | "Not enough credits available (N available, M required)." |
| Session/result belongs to another shop, or doesn't exist | a safe 404 (never distinguishable from "doesn't exist" — see "Tenant isolation") |
| Provider unavailable/timeout, malformed provider output, storage failure | the job reaches `FAILED` with the same merchant-safe messages every other generationType already produces (`services/generation/job.server.ts` — unchanged) |

Never exposed: provider stack traces, API keys, raw HTTP responses,
storage paths, or internal job IDs beyond what's already intentionally
safe (a `GenerationResult.id` used as a UI key). **Failed generation
never permanently consumes credits** — see "Credit lifecycle"'s
refund behavior.

## Tenant isolation (Part 12)

Every entry point takes the server-derived `AuthContext` and re-verifies
shop ownership before returning or mutating anything — the same
established pattern every other domain in this codebase uses:
`getCreativeSession`/`getCreativeSessionDetail` call
`assertShopOwnership` (via the repository) and throw
`CreativeSessionNotFoundError`/`TenantMismatchError` for a missing-or-
foreign-shop session, both mapped to the same safe 404 by the route (the
"existence oracle" prevention — cross-shop access is never
distinguishable from "doesn't exist"). `sendCreativeMessage`,
`selectCreativeResult`, and `reviewCreativeResult` all re-load the
session/result through the same tenant-scoped path — a client-supplied
session or result id can never reach another shop's data. See
`tests/integration/creative-studio/session.test.ts` and
`tests/integration/routes/app.creative-session-route.test.ts` for the
regression coverage, and `tests/e2e/creative-studio.spec.ts` for the
end-to-end check.

## Routing (Part 13)

- **Product Detail** (`/app/products/:id`) — an "AI Creative Studio"
  section: "Create with AI" (always starts a fresh session) plus a short
  list of the product's own prior sessions to resume. Each generation
  result card also offers "Continue editing" (starts a session with
  `sourceType: "GENERATION_RESULT"`).
- **AI Assets** (`/app/assets`) — "Open in Creative Studio" per row,
  offered only for `GENERATION`/`PROCESSING`-kind items (the merged view
  doesn't track a per-product id for `STORE_VISUAL`-kind rows — see
  `services/assets/types.ts`'s `AssetItem.productId` doc comment; the
  button is simply not offered there, mirroring `PublishControl`'s
  identical "no associated product" graceful degradation).
- **Store Visual detail** (`/app/store-visuals/:jobId`) — "Continue
  editing", offered only when the visual has at least one featured
  product (a Creative Session is always product-scoped; a fully generic
  store visual has nothing to continue editing against).

All of these create a session via `startCreativeSession` and redirect to
`/app/creative/:sessionId` — the one route this feature adds, following
the repository's flat-route convention.

**"Continue editing" and the session's first turn**: a session opened
this way has no result of its own yet on its first message — its
starting point is a *foreign* result outside its own `GenerationJob`
history. `session.server.ts`'s `resolveSessionStartingImage` resolves it
by reusing each domain's own `get*ResultForPublishing` accessor (already
shop-scoped and tenant-safe, built for `services/publishing/`) rather
than a new one, and the first turn's mode is corrected to
`IMAGE_TO_IMAGE` even if the parser guessed `TEXT_TO_IMAGE` (it has no
notion of a foreign starting result).

## Review, publish, and dead-end prevention

Creative Studio results are ordinary `GenerationResult` rows — Approve/
Reject reuse `services/generation/request-generation.server.ts`'s
existing `reviewGenerationResult` unchanged, and the existing
`PublishControl` component (`sourceType: "GENERATION_RESULT"`) works on
the Creative Studio route with zero new publishing code. Approval and
publishing remain separate concepts (approving never auto-publishes —
see docs/publishing.md). No button in this feature is a dead end: every
action either navigates somewhere real, submits a real mutation, or is
conditionally hidden when it has nothing valid to act on (e.g. "Continue
editing" absent for a fully generic store visual).

## Testing

- **Unit**: `tests/unit/ai/heuristic-intent-parser.test.ts` (taxonomy
  classification, structured extraction, mode inference),
  `tests/unit/creative-studio/{identity-constraints,creative-context,plan-builder}.test.ts`,
  `tests/unit/usage/entitlement.test.ts` (mocked repository — check/
  allow/deny logic).
- **Integration**: `tests/integration/creative-studio/session.test.ts` —
  real Postgres/Redis, a real `"generation"` worker, the deterministic
  test provider: session creation, tenant isolation, conversation
  persistence, a real generation request through the real queue,
  multiple results/variations, regeneration, image-to-image follow-ups,
  credit reserve/settle (success) and reserve/refund (a forced failure,
  built via the same `FORCE_FAILURE_ALWAYS` hook every other domain's
  tests already use), storage persistence, and previous-result
  preservation. `tests/integration/routes/app.creative-session-route.test.ts`
  covers the route layer (loader/action wiring, safe 404s).
- **E2E**: `tests/e2e/creative-studio.spec.ts` — open a product, start a
  session, send an instruction, watch it reach the real queue/worker
  seam, see the result, send a follow-up (verified image-to-image via
  the persisted plan), create variations, approve, regenerate, verify
  history remains, and verify tenant isolation (a session URL from
  another shop 404s). Polls the real `GenerationJob` row count/status
  directly rather than a UI signal that can be trivially already-true
  from a prior turn — see that file's `waitForJobCount` doc comment for
  a real, once-caught test-timing bug this replaced.

## Known limitations

- **No real AI vendor is configured.** Image generation still only ever
  runs through the deterministic test provider in this environment —
  the Creative Studio inherits this unchanged from every other
  generationType.
- **Intent parsing defaults to heuristic** unless a real LLM endpoint is
  configured (`AI_PROVIDER_BASE_URL`/`AI_PROVIDER_API_KEY`) — see "Intent
  model" above for the now-real `ProductionIntentParsingProvider`.
- **Identity validation remains non-semantic** — `recordIdentityValidation`
  (reused unchanged from Phase 5) returns an honest "not yet possible
  without a vision-capable provider" result, not a real check.
- **A real subscription/billing/credit-cost system now exists** — see
  docs/usage.md and docs/billing.md; this document's "Credit lifecycle"
  section above is a pointer to it, not a duplicate description.
- **Entitlement check-then-reserve is not atomic** — see docs/usage.md's
  "Known limitations".
- **A job-row-read failure specifically (not a provider/upload/persist
  failure) can leave a credit reservation stuck RESERVED forever** — if
  `services/generation/job.server.ts` can't even read the job row it was
  given (a rare infrastructure fault, not a normal failure mode), it
  can't know whether to refund a reservation it never learns about. A
  future cleanup pass (a scheduled sweep of long-outstanding RESERVED
  rows) would close this; not built here since it wasn't observed as a
  real occurrence.
- **No masks; only one reference image is actually constructed today**
  — `production-image-generation-provider.server.ts` now genuinely
  supports sending multiple reference images (`images[]` in the edits
  contract — see docs/ai-pipeline.md), but
  `services/creative-studio/plan-builder.ts` only ever populates
  `referenceImages` with a single entry (the prior result being edited
  forward from). Multi-reference conditioning (e.g. "use the second
  image as reference" alongside the current one) is a real capability
  the provider layer is ready for; the plan-building layer doesn't yet
  construct that request.
