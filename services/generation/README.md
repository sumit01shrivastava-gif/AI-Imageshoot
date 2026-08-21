# services/generation

Image generation foundation (Phase 3; extended Phase 5) — the layer
between Product Intelligence and an eventual real generative AI vendor:

- `types.ts` — the generation taxonomy (`GENERATION_TYPES`) and other
  shared string-literal unions, kept independent of `@prisma/client` so
  pure modules in this domain don't need a Prisma import.
- `schema.ts` — `GenerationPlanSchema` (Zod), the structured, validated
  request shape every generation is built from (Phase 5: gained
  `category`/`lifestyleScene`); `LifestyleSceneSchema`,
  `BrandStylePresetAttributesSchema` (Phase 5); `assertValidGenerateImageResult`,
  a light validation of a provider's raw output.
- `build-plan.ts` — pure mapping: a synced product + its Product
  Intelligence profile + chosen source images + generation type →
  `GenerationPlan`. The only place a generation prompt is synthesized
  (always from structured fields, never merchant-typed text). Phase 5
  added the `LIFESTYLE` branch (resolves a brand style preset + category
  defaults into a `LifestyleScenePlan`).
- `lifestyle-scene.ts` (Phase 5) — pure category/preset/override scene
  resolution, no I/O.
- `brand-style-presets.ts` (Phase 5) — the 6 built-in brand style presets,
  as code constants (never database rows).
- `brand-style-preset.server.ts` (Phase 5) — resolves/lists built-in +
  shop-saved custom presets.
- `build-input.ts` — pure mapping: a persisted `GenerationPlan` →
  `GenerateImageInput`, the shape `ImageGenerationProvider.generateImage`
  takes (Phase 5: flattens `plan.lifestyleScene` into `sceneDetails`).
- `identity-validation.server.ts` (Phase 5) — the honest, non-semantic
  identity-validation boundary (`recordIdentityValidation`) — see
  docs/lifestyle-generation.md "Identity validation".
- `provider.server.ts` — resolves which `ImageGenerationProvider` to use
  (always `UnconfiguredImageGenerationProvider` today — no vendor selected
  yet — except the test-only deterministic seam). Unchanged by Phase 5.
- `deterministic-test-provider.server.ts` — test-only
  `ImageGenerationProvider` double, never reachable outside
  `NODE_ENV=test`; includes forced-failure hooks for retry tests.
  Unchanged by Phase 5.
- `job.server.ts` / `queue.server.ts` — the `"generation"` BullMQ job
  payload/processor and its producer-side enqueue helper. Job-id and
  retry semantics deliberately differ from Phase 1/2's queues — see
  job.server.ts's module doc comment.
- `batch.server.ts` (Phase 5) — `startBatchGeneration`/
  `getGenerationBatchSummary`, mirroring `services/processing/batch.server.ts`.
- `request-generation.server.ts` — the service entry point routes call
  (`requestGeneration`, `getGeneration`, `listGenerationHistory`; Phase 5
  added `reviewGenerationResult` and the shared
  `createAndEnqueueGenerationJob` primitive both `requestGeneration` and
  `batch.server.ts` build on).

See docs/generation.md for the Phase 3 foundation and
docs/lifestyle-generation.md for Phase 5's lifestyle-imagery design (data
model, brand style presets, identity-validation boundary, batch
generation). No real AI vendor is installed and no image generation of
any kind happens outside the deterministic test provider — see
docs/roadmap.md.
