# AI Product Imagery — Lifestyle Scenes & Model Photography (Phases 5–6)

## Purpose

Phase 3 (docs/generation.md) built the image-generation foundation —
`GenerationJob`/`GenerationResult`, the `ImageGenerationProvider`
abstraction, the `"generation"` queue — proven only through
`PRODUCT_CLEANUP` and a deterministic test provider. Phase 4
(docs/image-processing.md) built production-grade *deterministic* image
transforms (background removal, enhance, resize) on a separate model
family, `ProcessingJob`/`ProcessingResult`/`ProcessingBatch`.

Phase 5 built the first **creative** generation capability merchants
actually use: placing a product in a photorealistic **lifestyle scene** —
`GenerationType.LIFESTYLE` — selectable per-product or in batch, built
from category-aware defaults and a merchant-chosen **brand style
preset**, reviewable and regenerable exactly like every other generation.
Phase 6 completes the Pro-plan "Package 2" capability set: **model
photography** (`GenerationType.MODEL_SHOOT`, gated on Product
Intelligence's existing `modelSuitable` signal) and merchant-selectable
**aspect ratio**, both sharing the same architecture, review flow, and —
on the product detail page — the same unified "AI Product Imagery"
section as lifestyle scenes.

**No real image-generation vendor is installed.** Every generation in
this codebase, like `PRODUCT_CLEANUP` before it, runs only through the
deterministic test provider — see "Provider strategy" below. No banners,
CTA imagery, campaign generation, Shopify publishing, billing,
subscriptions, credits, or plan enforcement are implemented — see
"Confirmations".

## Why this extends `GenerationJob`, not a new model family

Phase 4 deliberately built a *separate* `ProcessingJob` family rather than
reusing `GenerationJob`, because deterministic transforms (a fixed
algorithm applied to an existing image) are a genuinely different kind of
request from creative generation. Lifestyle generation is **not** that
kind of divergence — it is the exact same shape of request
`PRODUCT_CLEANUP` already is: a structured `GenerationPlan` → a
`GenerationJob` → one or more `GenerationResult`s, run through the same
`ImageGenerationProvider` abstraction and the same `"generation"` queue.
So Phase 5 **extends** the existing models/queue/provider abstraction
with targeted, additive fields rather than duplicating them — directly
satisfying the "do not duplicate queue infrastructure, storage
infrastructure, generation history concepts, batch progress concepts"
constraint this phase was built under.

## What's reused unchanged

- The `"generation"` BullMQ queue, `lib/queue/` factory, `workers/index.ts`
  registration, `(shop, generationJobId)` job-id scheme, `attempts: 3` +
  exponential backoff retry semantics — see docs/generation.md "Queue".
  LIFESTYLE jobs flow through the identical worker
  (`services/generation/job.server.ts`) as every other `GenerationType`.
- `GenerationJob`/`GenerationResult` as the persistence backbone.
- `services/ai/`'s `ImageGenerationProvider` interface,
  `UnconfiguredImageGenerationProvider`, and the deterministic test
  provider — unchanged.
- `services/intelligence/`'s Product Intelligence profile and
  `IdentityAnchorsSchema` — LIFESTYLE requires a `READY` profile exactly
  like `PRODUCT_CLEANUP` does (`ProductNotAnalyzedError` otherwise).
- Phase 1's `ImageSelection` as the batch source-selection mechanism —
  see "Batch generation" below.
- `lib/storage/`, signed `/media/*` serving, `lib/auth/tenant.server.ts`'s
  `assertShopOwnership`/`TenantMismatchError`, the safe-404 "existence
  oracle" convention — all provider/domain-agnostic, untouched.
- The `ReviewStatus` enum from Phase 4 (`PENDING`/`APPROVED`/`REJECTED`) —
  reused directly on `GenerationResult`, no new enum.

## Data model changes

One migration, `add_lifestyle_generation_foundation`, covering exactly
four targeted additions — reviewed against CLAUDE.md's "prefer the
smallest clean model" guidance before landing on this set rather than the
larger one an early sketch considered (a `LifestyleScenePlan` table, a
`Generation` versioning table — both rejected; see below):

```prisma
model GenerationJob {
  // ...existing Phase 3 fields...
  batchId String?
  batch   GenerationBatch? @relation(fields: [batchId], references: [id], onDelete: SetNull)
}

model GenerationResult {
  // ...existing Phase 3 fields...
  reviewStatus ReviewStatus @default(PENDING)
  reviewedAt   DateTime?
}

model GenerationBatch {
  id                String   @id @default(cuid())
  shop              String
  generationType    GenerationType
  sourceSelectionId String?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  jobs              GenerationJob[]
}

model BrandStylePreset {
  id          String   @id @default(cuid())
  shop        String
  name        String
  description String?
  attributes  Json
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@unique([shop, name])
}
```

**`GenerationBatch` mirrors `ProcessingBatch` field-for-field rather than
reusing it** — Prisma has no polymorphic relation, and `ProcessingBatch.operation`/
`.jobs` are typed to Processing's own enum/model. This is the same
"architectural consistency, not literal table reuse" call Phase 4 already
made for not reusing `GenerationJob` itself.

**No `LifestyleScenePlan` table.** The scene plan lives inside the
existing `GenerationJob.plan` JSON snapshot (see "LifestyleScenePlan"
below) — a `GenerationJob` already snapshots "the full structured
request" generically, so a separate table would just duplicate what's
already persisted and versioned for free.

**No new "generation version" table.** History/versioning was already
fully solved in Phase 3: every `request*` call creates a brand-new,
never-overwritten `GenerationJob` row (Generation #1, #2, #3, ...) — the
exact mechanism this phase's regeneration reuses unchanged.

**Only shop-saved CUSTOM presets are `BrandStylePreset` rows.** The 6
named built-in presets are **code constants**
(`services/generation/brand-style-presets.ts`), not seeded database rows
— see "Brand style presets" below for why.

**Phase 6 (model imagery + aspect ratio) required zero Prisma
migrations.** `MODEL_SHOOT` reuses `GenerationJob`/`GenerationResult`/
`BrandStylePreset`/`GenerationBatch` and Product Intelligence's existing
`modelSuitable`/`recommendedPoseTypes`/`recommendedModelAttributes`
columns (populated since Phase 2, never before consumed) exactly as-is;
aspect ratio was already a plain string inside the `GenerationJob.plan`
JSON snapshot (`DEFAULT_ASPECT_RATIO = "1:1"`, hardcoded) — making it
merchant-selectable only tightened its Zod validation
(`GenerationPlanSchema.aspectRatio`: `z.string().min(1)` →
`AspectRatioSchema`, i.e. `z.enum(ASPECT_RATIOS)`), a schema-only change
with no column of its own.

## Provider strategy

**No real image-generation vendor is selected this phase**, for the same
reason Phase 3 shipped `PRODUCT_CLEANUP` without one: true generative
lifestyle synthesis (placing a product convincingly in a novel scene
while preserving its exact appearance) needs a genuinely
generative/image-to-image model and real vendor credentials, neither of
which exist in this environment.
`services/generation/provider.server.ts` is **unchanged** —
`getConfiguredImageGenerationProvider()` still resolves to
`UnconfiguredImageGenerationProvider` everywhere except the double-gated
deterministic test seam (`NODE_ENV === "test"` AND `AI_PROVIDER ===
"deterministic-test"`). LIFESTYLE generation runs through the exact same
resolver `PRODUCT_CLEANUP` already does, and the deterministic test
provider needed **zero changes** — it already produces N valid
placeholder outputs regardless of `generationType`/`sceneDetails`, and
its existing `FORCE_FAILURE_ALWAYS`/`FORCE_FAILURE_ONCE` hooks (keyed off
`creativeDirection.negativeConstraints`) work unchanged for
lifestyle-specific failure/retry tests.

**The provider-adapter boundary**: `GenerateImageInput`
(`services/ai/types.ts`) gained exactly one new optional field —
`sceneDetails?: Record<string, unknown>` — deliberately generic and
domain-shape-agnostic, mirroring how `productFacts` is already typed
(`services/ai/` must never import a concrete Product Intelligence or
Generation type). `services/generation/build-input.ts` flattens
`plan.lifestyleScene` into `sceneDetails`; a future real vendor
implementation decides how to use it (structured params, folded into its
own prompt construction, an image-to-image reference call, ...) —
`services/ai/` itself never needs to know the concrete field names.

Candidate approaches for a future real integration (named for future
evaluation only — no SDK installed, no vendor chosen, no vendor-specific
env var added): image-to-image / reference-conditioned generation that
holds the product's own pixels as a strong prior; inpainting-style
compositing that keeps the product region fixed and only generates the
surrounding scene. `AI_PROVIDER`/`AI_PROVIDER_API_KEY`/`AI_PROVIDER_BASE_URL`
(already declared in `lib/validation/env.server.ts`, already unread for
this purpose) remain the intended future hook.

## `LifestyleScenePlan`

Not a giant prompt string, and not a new top-level Prisma column — an
**optional nested field on the existing `GenerationPlanSchema`**,
populated only when `generationType === "LIFESTYLE"` (kept out of
`creativeDirection` so `PRODUCT_CLEANUP`'s existing, tested shape is
untouched):

```ts
// services/generation/schema.ts
export const LifestyleSceneSchema = z.object({
  sceneType: z.string().min(1).nullable(),        // "environmental" this phase — the only treatment offered
  surface: z.string().min(1).nullable(),
  props: z.array(z.string()).default([]),
  camera: z.string().min(1).nullable(),
  mood: z.string().min(1).nullable(),
  colorDirection: z.string().min(1).nullable(),
});

// GenerationPlanSchema additions:
category: z.string().min(1).nullable(),            // mirrors assetType's placement
lifestyleScene: LifestyleSceneSchema.nullable(),    // null for every non-LIFESTYLE generationType
```

`environment`/`lighting`/`composition`/`negativeConstraints` stay exactly
where they already lived, in `creativeDirection` — meaningful for every
generation type, not lifestyle-specific. `aspectRatio`/`brandStyle` also
already existed at the plan's top level (`brandStyle` is now, for the
first time, actually populated — see "Brand style presets"). This gives
the full requested field set — `productFacts`, `category`, `sceneType`,
`environment`, `surface`, `lighting`, `props`, `composition`, `camera`,
`mood`, `colorDirection`, `aspectRatio`, `brandStyle`,
`negativeConstraints` — without inventing a disconnected second plan
object.

**Resolution order** (`services/generation/lifestyle-scene.ts`'s
`buildLifestyleScene`, pure, no I/O): a merchant scene-control override
(if any) → the resolved brand style preset's own attributes → category-aware
defaults (`services/intelligence/category-recommendations.ts`, reused —
see below). Never throws; every field always resolves to something,
falling back to a generic-but-sensible default for a category that
matches nothing known.

`build-plan.ts`'s LIFESTYLE branch synthesizes a real, structured prompt
sentence from the resolved scene (never a merchant-typed string — the
"no arbitrary prompts" rule from docs/generation.md applies identically
here) and always appends the same identity-preservation instruction
`PRODUCT_CLEANUP` uses.

## Category-aware defaults

`services/intelligence/category-recommendations.ts`'s `CATEGORY_PROFILES`
table (Phase 2, already cross-phase-reused for
`recommendedAssetTypes`/`recommendedEnvironments`/`recommendedPoseTypes`)
gained four new **optional** fields per category:
`recommendedSurfaces`, `recommendedProps`, `recommendedMood`,
`recommendedColorDirection`. All 9 category profiles (jewelry, eyewear,
handbags, shoes, clothing, furniture, appliances, electronics, food) and
the default fallback were populated with category-appropriate values
(e.g. jewelry → velvet/polished marble, elegant mood; furniture → potted
plant/throw pillow props, cozy mood). Purely additive — every existing
Phase 2 consumer of this table is unaffected (all new fields optional,
verified by the unchanged Phase 2 test suite staying green).

## Brand style presets

A **named, reusable scene + brand-tone configuration** a merchant picks
(or, architecturally, saves) — the one genuinely new domain concept this
phase introduces; nothing in the existing schema represented "a reusable
creative preset."

**6 built-in presets, code constants, not database rows**
(`services/generation/brand-style-presets.ts`, a data table in the exact
style of `category-recommendations.ts`'s `CATEGORY_PROFILES`): Minimal
Studio, Luxury Editorial, Natural Lifestyle, Premium Modern, Warm
Lifestyle, Clean Commercial. Each carries a rich `attributes` object
(visual tone, photography style, background/lighting/composition style,
environment, surface, props, mood, color direction, negative
constraints) validated once at module load against
`BrandStylePresetAttributesSchema` — a typo in the catalog fails loudly
at import time, not silently at generation time. Zero migration cost,
available to every shop.

**Only shop-saved CUSTOM presets are `BrandStylePreset` rows** —
`db/repositories/brand-style-preset.repository.ts` (shop-scoped CRUD,
`@@unique([shop, name])`, a custom preset can never collide with a
built-in preset's name — enforced in the service layer, since the
built-ins aren't rows the database constraint could catch) +
`services/generation/brand-style-preset.server.ts` (`listAvailablePresets`
merges built-ins ++ a shop's own custom presets; `resolveBrandStylePreset`
checks the built-in catalog first, no I/O, before falling back to a
shop-scoped DB lookup).

`BrandStylePresetAttributesSchema` is deliberately a **superset** of the
existing `BrandStyleContextSchema` (the narrower shape actually sent to a
provider) plus scene defaults — the instructions' own preset examples mix
brand-style attributes (mood, photography style) and scene attributes
(environment, props) into one reusable named thing, so this is one
schema, not two competing "brand style" vs. "lifestyle preset" concepts.
`build-plan.ts`'s `toBrandStyleContext` picks out just the
`BrandStyleContext` fields when populating `plan.brandStyle`.

**An unknown/stale presetId is never an error.** `resolveBrandStylePreset`
returns `null` for an unknown id, a cross-shop custom preset id (mapped
from `TenantMismatchError`), or an empty string — `requestGeneration`
then silently falls back to category-aware defaults, the same as passing
no preset at all. A bad or stale id must never block generation.

**Not built this phase**: a "Save as custom preset" UI action. The
model/repository/service are fully built and tested — adding that button
later is additive, not a redesign.

## Model imagery (Phase 6)

`GenerationType.MODEL_SHOOT` — model photography featuring the product —
completes Package 2 without any new data model. It reuses:

- **The same `BrandStylePreset`** as LIFESTYLE, specifically its
  `modelStyle` attribute (part of `BrandStylePresetAttributesSchema`
  since Phase 3's original `BrandStyleContextSchema`, but unused by any
  generationType until now). There is deliberately **no separate
  "ModelPreset" model** — the instructions' own preset examples already
  treat brand style and model styling as one reusable named thing, and
  inventing a second, parallel preset concept would just fragment that.
- **Product Intelligence's existing `modelSuitable`/`recommendedPoseTypes`/
  `recommendedModelAttributes`** (Phase 2 fields, populated by
  `category-recommendations.ts` since the very first `CATEGORY_PROFILES`
  table but never consumed downstream until this phase).

**Gated on `modelSuitable === true`.** `build-plan.ts` throws
`ProductNotModelSuitableError` for any other value (`false` or `null`) —
mirrors `ProductNotAnalyzedError`'s "require the real precondition, don't
silently generate something meaningless" reasoning (jewelry/eyewear/
handbags/shoes/clothing are model-suitable; furniture/appliances/
electronics/food are not — see `category-recommendations.ts`'s
`CATEGORY_PROFILES`). In a batch, one product failing this gate is
skipped-and-logged exactly like `ProductNotAnalyzedError`/
`MissingSourceImagesError` already were for LIFESTYLE — not a new failure
mode, the same "one image failing to even be created must not abort the
batch" handling.

The synthesized prompt uses `recommendedPoseTypes[0]` (the category's
top recommended pose) and deliberately generic language ("Model
photography **featuring** the product," not "worn by") since
`modelSuitable` spans categories that aren't all literally worn the same
way. `lifestyleScene` stays `null` for MODEL_SHOOT (it's a LIFESTYLE-only
concept); `brandStyle` is populated exactly as it is for LIFESTYLE.

## Aspect ratio (Phase 6)

Package 2 explicitly calls for "multiple aspect ratios." Rather than a
second, parallel multi-output-per-ratio pipeline, this is satisfied the
same way every other creative choice already works in this domain:
**a curated aspect ratio picker** (`services/generation/types.ts`'s
`ASPECT_RATIOS`: `1:1`, `4:5`, `9:16`, `16:9` — never a merchant-typed
dimension string) applies to a single request, and "multiple aspect
ratios" for one product is simply requesting generation again with a
different ratio selected — each becomes its own new, independently
preserved, independently reviewable `GenerationResult`, exactly like
requesting a different preset or regenerating does. `GenerationPlanSchema.aspectRatio`
was tightened from a free `z.string().min(1)` to `AspectRatioSchema`
(`z.enum(ASPECT_RATIOS)`) now that it's genuinely merchant-controllable —
consistent with every other structured, curated-only creative-direction
field in this domain. Applies to every `GenerationType`, not only
LIFESTYLE/MODEL_SHOOT (though `PRODUCT_CLEANUP`'s minimal UI still never
exposes a picker — it keeps defaulting to `1:1`, unchanged).

On a batch's own progress page, "Regenerate" preserves the **original
job's own aspect ratio** (read back off its persisted `plan.aspectRatio`)
rather than defaulting to `1:1` — a batch has no per-job aspect-ratio
picker to re-select from, so silently reverting to the default on
regenerate would have been a real, easy-to-miss regression.

## Identity validation — an explicit, honest boundary

**Including `identityAnchors` in the prompt/`productFacts` sent to a
provider is NOT the same as verifying the resulting image actually
preserved them.** This phase does not pretend otherwise. Genuine
verification would require a vision-capable model comparing the
generated output against the source image's identity anchors
(material/color/shape/hardware/branding) — no such provider is selected
in this codebase (see "Provider strategy" above); the deterministic test
provider produces placeholder pixels with no real relationship to the
source image at all.

So `services/generation/identity-validation.server.ts`'s
`recordIdentityValidation` is a **named, separate pipeline step** —
called in `job.server.ts` between `assertValidGenerateImageResult`
(structural output validity) and persistence — that returns an honest,
structured "not yet possible" result:

```ts
{ validated: false, reason: "no vision-capable provider configured", identityAnchorsChecked: [...] }
```

`identityAnchorsChecked` lists exactly which of the product's own
identity-anchor fields are present (always includes `category`;
conditionally `shape`/`material`/`primaryColor`/`constructionDetails`/
`distinctiveHardware`/`brandingVisible`+`brandingDescription`) — so the
merchant-facing data model already exposes *what a real check would need
to verify*, today, in `GenerationResult.metadata.identityValidation`. A
later phase implementing a real check only needs to change this one
function's body (call a vision model, compare structurally, ...) — no
pipeline or schema change required when that day comes. This function is
called for every generation result, not only LIFESTYLE — identity
preservation matters for every `GenerationType`.

## Batch generation

Reuses Phase 4's exact batch pattern — no new queue, no new progress
mechanism:

- `services/generation/batch.server.ts`'s `startBatchGeneration` reads
  `getImageSelectionSummary` (Phase 1, unchanged), creates a
  `GenerationBatch` row, then loops the selection's images calling
  `createAndEnqueueGenerationJob` (a shared primitive factored out of
  `request-generation.server.ts` — both the single-product
  `requestGeneration` and batch generation build on it, mirroring
  `services/processing/request-processing.server.ts`'s
  `createAndEnqueueProcessingJob`) once per image — one image's job
  failing to even be **created** (not processed) is logged and skipped,
  never aborting the whole batch. Unlike Phase 4 (where the only
  realistic trigger is a genuine race), this failure mode has a real,
  non-racy trigger for LIFESTYLE: a selection containing a product that
  was never analyzed (`ProductNotAnalyzedError`) — exercised directly in
  `tests/integration/generation/batch-generation.test.ts`, not left as an
  untested edge case.
- `getGenerationBatchProgress` (`db/repositories/generation-batch.repository.ts`)
  is computed at read time via a `groupBy` over `GenerationJob.status`
  scoped to the batch — never a persisted counter, so it can never drift
  from the jobs it summarizes (the same "derive, don't duplicate"
  principle as `services/intelligence/stale.ts`'s staleness check and
  Phase 4's `getBatchProgress`).
- A single brand style preset applies to every job in the batch (no
  per-image preset picker this phase — the batch UI offers one preset
  choice before "Start generating," matching the "minimal, curated
  controls" framing for this phase's UI).

## Review, regeneration, and generation history

`GenerationResult.reviewStatus`/`reviewedAt` (reusing Phase 4's
`ReviewStatus` enum) is set via
`db/repositories/generation-job.repository.ts`'s
`setGenerationResultReviewStatus` /
`services/generation/request-generation.server.ts`'s
`reviewGenerationResult` — approving/rejecting **never mutates or deletes**
the result row itself; every result stays permanently in history exactly
as generated.

Regeneration is, as in Phase 3, simply calling
`createAndEnqueueGenerationJob` again with the same product/source
images/generationType — a brand-new `GenerationJob` row, never an
overwrite of the previous one. The scene plan actually used for a given
generation is preserved automatically, because `GenerationJob.plan` is
snapshotted whole at creation time — there is no separate "which preset
was used" field to keep in sync. On the product-detail page, "Regenerate"
uses whichever preset the merchant currently has selected in the picker
(not necessarily the one the original request used) — a deliberate v1
simplification consistent with this phase's "preset + a couple of curated
pickers, not a full studio UI" scope; on a batch's own progress page,
"Regenerate" re-runs with no preset (falls back to category-aware
defaults), since a batch has no per-job preset picker.

## UI

**Product detail** (`app/routes/app.products.$id.tsx`): a single unified
"AI Product Imagery" section, alongside (not replacing) the existing
`PRODUCT_CLEANUP`-only "Image Generation" section — kept as a genuinely
separate action (`generate-product-imagery`/`regenerate-product-imagery`
intents) rather than a generalization of the existing `generate` intent,
so the already-shipped `PRODUCT_CLEANUP` path is at zero risk of
regression. LIFESTYLE and MODEL_SHOOT share this one section rather than
each getting their own (Phase 5 shipped a "AI Lifestyle Imagery"-only
section; Phase 6 generalized it to "AI Product Imagery" once MODEL_SHOOT
existed as a second, near-identical merchant-facing choice) — same
status badge, Generate/Regenerate button, failure banner, review card,
and history list, filtered to `type === "LIFESTYLE" || type === "MODEL_SHOOT"`
(the same `generationHistory` list Phase 3 already loads;
`PRODUCT_CLEANUP`'s own history is filtered separately, so the sections
never show each other's jobs). Contains: a **Style** picker (Lifestyle
scene / Model photography — the latter option disabled with an inline
note when Product Intelligence says this product isn't model-suitable),
a **Brand style** preset picker (built-ins + this shop's saved custom
presets, plus a "No preset — category defaults" option, shared by both
styles), an **Aspect ratio** picker (`1:1`/`4:5`/`9:16`/`16:9`), and the
Generate/Regenerate button (disabled until Product Intelligence is
`READY`, and additionally until model-suitable when Style is Model
photography).

**Batch flow** (`app/routes/app.products.selection.tsx`): the existing
"Review selection" screen's **Mode** picker now has three options —
"Process images," "Generate lifestyle imagery," "Generate model
imagery" — the latter two reveal the same brand style preset picker
before "Start generating," which POSTs the generalized
`start-generation-batch` intent (`generationType` field; Phase 5's
`start-lifestyle-batch` was renamed/broadened for this) and redirects
into `app/routes/app.generation.$batchId.tsx` (progress, per-job
original-vs-generated card, Approve/Reject/Regenerate) — a structural
mirror of `app/routes/app.processing.$batchId.tsx`. No batch-level aspect
ratio picker (`1:1` default) — kept out for the same "curated, not a full
studio UI" scope reasoning as the rest of this feature; a batch's own
"Regenerate" preserves whichever aspect ratio the original job actually
used (read back off its persisted plan), not the `1:1` default.

**Not built yet**: a UI to save a new custom preset, a full scene-control
panel (environment/surface/props/camera/mood/colorDirection all
individually editable — only the preset choice is merchant-facing), a
per-image source picker for batch generation (batch always uses the
merchant's `ImageSelection`, same as Phase 4), an output-count picker,
a batch-level aspect ratio picker.

## Security / tenant isolation

Every new/extended entry point follows the one established pattern
throughout this codebase — takes an `AuthContext`, re-verifies shop
ownership before returning or mutating anything, never trusts a
client-supplied id:

- `BrandStylePreset`: shop-scoped rows (`@@unique([shop, name])`); a
  cross-shop preset id resolves to `null` (via `getBrandStylePresetRow`'s
  `TenantMismatchError` being caught, not propagated) — never leaked,
  never usable in another shop's plan, and indistinguishable from an
  unknown id.
- `GenerationBatch`: `assertShopOwnership` on load
  (`getGenerationBatch`), mirroring `ProcessingBatch`'s `getBatch`.
- `GenerationJob`/`GenerationResult`: the existing Phase 3
  `assertShopOwnership` checks already cover the new `batchId`/
  `reviewStatus`/`reviewedAt` fields with no additional work; a
  cross-shop `resultId` passed to `reviewGenerationResult` throws
  `GenerationResultNotFoundError` — the same safe-404 shape every other
  not-found case in this app uses.
- Source media ids for a batch are never trusted directly — the same
  "only proceed if it appears in the shop-verified product's own media"
  rule `build-plan.ts` already enforced for Phase 3.
- No new secret surface: no new vendor, no new credential, no new env
  var (see "Environment variables" below).

## Testing

Unit (`tests/unit/generation/`): `brand-style-presets.test.ts` (catalog
shape, schema validation, uniqueness), `lifestyle-scene.test.ts`
(category-default fallback, preset-overrides-category,
merchant-override-wins-over-both, unknown-category-never-throws),
`identity-validation.test.ts` (the boundary function's honest
not-validated result shape, which anchor fields get listed), extended
`schema.test.ts`/`build-input.test.ts` (the new plan fields,
`sceneDetails` flattening), extended `build-plan.test.ts` (LIFESTYLE
branch: preset resolution, category fallback, scene-override precedence;
MODEL_SHOOT branch (Phase 6): the `modelSuitable` gate — both `false` and
`null` throw `ProductNotModelSuitableError` — pose/brandStyle resolution,
`lifestyleScene` stays null; aspect ratio: defaults to `1:1`, an override
is reflected on the plan; brandStyle/lifestyleScene stay null for every
generationType outside LIFESTYLE/MODEL_SHOOT even if a preset is passed;
the identity-preservation instruction is always present).

Integration (real Postgres + Redis + an in-process BullMQ `Worker` + the
real `processGenerationJob` — never mocked): repository lifecycle
(`generation-batch.repository.test.ts`, `brand-style-preset.repository.test.ts`,
extended `generation-job.repository.test.ts` for review/batch support),
full single-request end-to-end for LIFESTYLE
(`lifestyle-generation-queue.test.ts` — category-aware scene plan,
honest identity-validation metadata persisted, presetId resolution
through the real preset service, an unknown presetId falling back
safely, original product media never mutated, `reviewGenerationResult`)
and for MODEL_SHOOT (`model-shoot-queue.test.ts` — pose/brandStyle
resolution, the modelSuitable gate via `requestGeneration`, an unknown
aspect ratio throwing `InvalidGenerationRequestError` rather than
silently substituting a default, original media untouched), batch
end-to-end (`batch-generation.test.ts` — LIFESTYLE all-succeeded and a
REAL (non-racy) partial-skip case (one selected product was never
analyzed); MODEL_SHOOT's own partial-skip case (one selected product
isn't model-suitable); an aspect ratio applying to every job in a batch),
and route-level tests for all four routes
(`app.products.id-lifestyle-generation-action.test.ts` (LIFESTYLE),
`app.products.id-model-shoot-action.test.ts` (MODEL_SHOOT, Phase 6),
`app.generation.batch-action.test.ts`,
`app.products.selection-start-generation-batch.test.ts` (both
generationTypes, Phase 6 — renamed/broadened from Phase 5's
`...-start-lifestyle-batch.test.ts`)).

E2E (`tests/e2e/lifestyle-generation.spec.ts`): a single-product LIFESTYLE
scenario (pick a preset → generate → succeeded → original untouched →
approve → regenerate → the previous approved result remains in history),
a single-product MODEL_SHOOT scenario (Phase 6 — switch the Style picker,
pick an aspect ratio, generate, verify the persisted job's type/status
directly since "Model photography" legitimately appears several times in
the DOM once a result exists), and a batch scenario (select multiple
products → choose "Generate lifestyle imagery" → pick a preset → start →
batch progress → completed → review → approve → regenerate → the
previous result remains) — mirroring `tests/e2e/processing.spec.ts`'s
multi-scenario structure, a real in-process `"generation"` worker, real
deterministic provider, real queue — never mocked.

## Environment variables

**None required.** No real vendor is selected, so no new secret/config
env var is needed to ship this phase. `AI_PROVIDER`/`AI_PROVIDER_API_KEY`/
`AI_PROVIDER_BASE_URL` (already declared, already unread for image
generation) remain the intended future hook.

## Confirmations

- **No real image-generation vendor was integrated.** Every generation in
  this codebase runs only through the deterministic test provider,
  exactly like `PRODUCT_CLEANUP`. `services/generation/provider.server.ts`
  is unchanged from Phase 3.
- **Identity validation remains non-semantic.** A documented, honest "not
  yet possible without a vision-capable provider" result — not a real
  check. See "Identity validation" above; do not mistake this for
  "identity preservation is solved." Applies identically to MODEL_SHOOT.
- **No banners, category banners, CTA imagery, or campaign generation.**
  Only `LIFESTYLE` and, as of Phase 6, `MODEL_SHOOT` are driven end to
  end; `BANNER`/`CATEGORY_BANNER`/`CTA`/`CAMPAIGN` remain schema-accepted,
  unimplemented taxonomy — Package 3, not yet scoped.
- **MODEL_SHOOT never generates a real depiction of a person.** The
  deterministic test provider (the only one wired up) produces a
  placeholder pixel with no relationship to a human model whatsoever —
  see "Provider strategy." Selecting a real generative vendor for this
  generationType, and any attendant representation/diversity/consent
  policy, is future work requiring a product decision this phase doesn't
  make.
- **No billing/subscriptions/credits/plan enforcement.** Nothing in this
  phase gates a feature behind a plan tier at runtime — the Pro/Basic
  distinction is a product-positioning statement, not enforced code.
- **No publishing back to Shopify.** Generated results stay in this app's
  own storage/database.
- **`services/processing/` was not modified.** Phase 4 remains exactly as
  committed (`b722bfc`), and Phase 6 did not touch it either.
