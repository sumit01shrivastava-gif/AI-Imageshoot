# services/generation

Image generation foundation (Phase 3; extended Phases 5–7) — the layer
between Product Intelligence and an eventual real generative AI vendor:

- `types.ts` — the generation taxonomy (`GENERATION_TYPES`) and other
  shared string-literal unions, kept independent of `@prisma/client` so
  pure modules in this domain don't need a Prisma import. Phase 6 added
  `ASPECT_RATIOS` (Phase 7 added `21:9` to it).
- `schema.ts` — `GenerationPlanSchema` (Zod), the structured, validated
  request shape every generation is built from (Phase 5: gained
  `category`/`lifestyleScene`; Phase 6: `aspectRatio` tightened from a
  free string to `AspectRatioSchema`); `LifestyleSceneSchema`,
  `BrandStylePresetAttributesSchema` (Phase 5); `assertValidGenerateImageResult`,
  a light validation of a provider's raw output.
- `build-plan.ts` — pure mapping: a synced product + its Product
  Intelligence profile + chosen source images + generation type →
  `GenerationPlan`. The only place a generation prompt is synthesized
  (always from structured fields, never merchant-typed text). Phase 5
  added the `LIFESTYLE` branch (resolves a brand style preset + category
  defaults into a `LifestyleScenePlan`); Phase 6 added the `MODEL_SHOOT`
  branch (gated on `modelSuitable`, resolves a pose from Product
  Intelligence's `recommendedPoseTypes` + the same `BrandStylePreset`'s
  `modelStyle`) and threaded an `aspectRatioOverride` through every
  generationType; Phase 7 added `BANNER`/`CTA` branches (no
  `modelSuitable`-style gate, resolve a preset's
  `backgroundStyle`/`compositionStyle`/`mood`, explicitly instruct
  against rendering text/logos) and `DEFAULT_ASPECT_RATIO_BY_TYPE`
  (BANNER defaults to a wide `21:9`).
- `lifestyle-scene.ts` (Phase 5) — pure category/preset/override scene
  resolution, no I/O.
- `brand-style-presets.ts` (Phase 5) — the 6 built-in brand style presets,
  as code constants (never database rows). Phase 6's MODEL_SHOOT and
  Phase 7's BANNER/CTA all reuse the same presets — no separate catalog
  per generationType.
- `brand-style-preset.server.ts` (Phase 5) — resolves/lists built-in +
  shop-saved custom presets.
- `build-input.ts` — pure mapping: a persisted `GenerationPlan` →
  `GenerateImageInput`, the shape `ImageGenerationProvider.generateImage`
  takes (Phase 5: flattens `plan.lifestyleScene` into `sceneDetails`).
- `identity-validation.server.ts` (Phase 5) — the honest, non-semantic
  identity-validation boundary (`recordIdentityValidation`) — see
  docs/lifestyle-generation.md "Identity validation". Applies to every
  generationType, including Phase 6's MODEL_SHOOT and Phase 7's
  BANNER/CTA.
- `provider.server.ts` — resolves which `ImageGenerationProvider` to use
  (always `UnconfiguredImageGenerationProvider` today — no vendor selected
  yet — except the test-only deterministic seam). Unchanged since Phase 3.
- `deterministic-test-provider.server.ts` — test-only
  `ImageGenerationProvider` double, never reachable outside
  `NODE_ENV=test`; includes forced-failure hooks for retry tests.
  Unchanged since Phase 3.
- `job.server.ts` / `queue.server.ts` — the `"generation"` BullMQ job
  payload/processor and its producer-side enqueue helper. Job-id and
  retry semantics deliberately differ from Phase 1/2's queues — see
  job.server.ts's module doc comment.
- `batch.server.ts` (Phase 5; Phase 6 added aspect ratio) —
  `startBatchGeneration`/`getGenerationBatchSummary`, mirroring
  `services/processing/batch.server.ts`. BANNER/CTA batches (Phase 7)
  needed no code change — `generationType` was already generic.
- `request-generation.server.ts` — the service entry point routes call
  (`requestGeneration`, `getGeneration`, `listGenerationHistory`; Phase 5
  added `reviewGenerationResult` and the shared
  `createAndEnqueueGenerationJob` primitive both `requestGeneration` and
  `batch.server.ts` build on; Phase 6 added `aspectRatio` validation).

See docs/generation.md for the Phase 3 foundation and
docs/lifestyle-generation.md for Phases 5–7's lifestyle/model/banner-CTA
imagery design (data model, brand style presets, identity-validation
boundary, batch generation, aspect ratio, Package 3 scoping decision). No
real AI vendor is installed and no image generation of any kind happens
outside the deterministic test provider — see docs/roadmap.md.
