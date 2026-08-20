/**
 * Generation taxonomy and its supporting shared types.
 *
 * `GENERATION_TYPES` mirrors `prisma/schema.prisma`'s `GenerationType`
 * enum values (kept as a plain string-literal union here — not imported
 * from `@prisma/client` — so pure, no-I/O modules in this domain, e.g.
 * schema.ts/plan.ts, don't need a Prisma import; job.server.ts/the
 * repository still use `@prisma/client`'s own `GenerationType` where a
 * real Prisma value is required). Any change to one must be mirrored in
 * the other — see tests/unit/generation/types.test.ts.
 */

/** See docs/generation.md "Generation types" for what each value means and
 * which of them this phase actually drives end to end (only
 * PRODUCT_CLEANUP — the rest are valid, schema-accepted values with no
 * dedicated plan-building logic yet). */
export const GENERATION_TYPES = [
  "PRODUCT_CLEANUP",
  "BACKGROUND_REMOVAL",
  "BACKGROUND_REPLACEMENT",
  "LIFESTYLE",
  "MODEL_SHOOT",
  "BANNER",
  "CATEGORY_BANNER",
  "CTA",
  "CAMPAIGN",
] as const;

export type GenerationTypeValue = (typeof GENERATION_TYPES)[number];

export const OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
export type OutputFormatValue = (typeof OUTPUT_FORMATS)[number];

export const GENERATION_QUALITIES = ["draft", "standard", "high"] as const;
export type GenerationQualityValue = (typeof GENERATION_QUALITIES)[number];
