# services/generation (placeholder)

Future home of generation orchestration business logic (`GenerationJob`,
`GenerationResult`, `GenerationPreset`, batch generation, presets/brand
style). Will depend on `services/ai` (the provider abstraction) and
`lib/queue`, never on a specific AI vendor SDK directly. Not implemented in
Phase 0 — see docs/generation-pipeline.md and docs/roadmap.md.
