# services/processing

Production image processing — the Basic plan foundation (Phase 4):

- `types.ts` — the operation taxonomy (`IMAGE_OPERATIONS`) and aspect-
  ratio presets, kept independent of `@prisma/client`.
- `schema.ts` — `ProcessingOptionsSchema` (Zod), the validated
  operation-options shape; `assertValidProcessingOutput`, a light
  validation of a provider's raw output.
- `build-input.ts` — pure mapping: a source image reference + validated
  options → `ImageProcessingInput`.
- `provider.server.ts` — resolves which `ImageProcessingProvider` to use:
  the real `ProductionImageProcessingProvider`
  (services/ai/production-image-processing-provider.server.ts) when
  `IMAGE_PROCESSING_PROVIDER` is set, the double-gated deterministic test
  provider in tests, `UnconfiguredImageProcessingProvider` otherwise.
- `deterministic-test-provider.server.ts` — test-only
  `ImageProcessingProvider` double, never reachable outside
  `NODE_ENV=test`; includes forced-failure hooks for retry tests.
- `job.server.ts` / `queue.server.ts` — the `"enhancement"` BullMQ job
  payload/processor and its producer-side enqueue helper.
- `request-processing.server.ts` — the single-image service entry point
  (`requestProcessing`, `getProcessing`, `listProcessingHistory`,
  `reviewProcessingResult`) and the shared
  `createAndEnqueueProcessingJob` primitive.
- `batch.server.ts` — the batch entry point
  (`startBatchProcessing`/`getBatchSummary`), built on the same
  `createAndEnqueueProcessingJob` primitive, consuming Phase 1's
  `ImageSelection`.

See docs/image-processing.md for the full architecture, provider
selection reasoning, data model, batch/versioning design, and identity
-preservation approach. Lifestyle/model/campaign generation is a later
phase — see docs/roadmap.md.
