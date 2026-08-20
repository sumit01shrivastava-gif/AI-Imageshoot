# services/generation

Image generation foundation (Phase 3) — the layer between Product
Intelligence and an eventual real generative AI vendor:

- `types.ts` — the generation taxonomy (`GENERATION_TYPES`) and other
  shared string-literal unions, kept independent of `@prisma/client` so
  pure modules in this domain don't need a Prisma import.
- `schema.ts` — `GenerationPlanSchema` (Zod), the structured, validated
  request shape every generation is built from; `assertValidGenerateImageResult`,
  a light validation of a provider's raw output.
- `build-plan.ts` — pure mapping: a synced product + its Product
  Intelligence profile + chosen source images + generation type →
  `GenerationPlan`. The only place a generation prompt is synthesized
  (always from structured fields, never merchant-typed text).
- `build-input.ts` — pure mapping: a persisted `GenerationPlan` →
  `GenerateImageInput`, the shape `ImageGenerationProvider.generateImage`
  takes.
- `provider.server.ts` — resolves which `ImageGenerationProvider` to use
  (always `UnconfiguredImageGenerationProvider` today — no vendor selected
  yet — except the test-only deterministic seam).
- `deterministic-test-provider.server.ts` — test-only
  `ImageGenerationProvider` double, never reachable outside
  `NODE_ENV=test`; includes forced-failure hooks for retry tests.
- `job.server.ts` / `queue.server.ts` — the `"generation"` BullMQ job
  payload/processor and its producer-side enqueue helper. Job-id and
  retry semantics deliberately differ from Phase 1/2's queues — see
  job.server.ts's module doc comment.
- `request-generation.server.ts` — the service entry point routes call
  (`requestGeneration`, `getGeneration`, `listGenerationHistory`).

See docs/generation.md for the full architecture, data model, provider
abstraction, queue lifecycle, and identity-preservation design. No real AI
vendor is installed and no image generation of any kind happens outside
the deterministic test provider — see docs/roadmap.md.
