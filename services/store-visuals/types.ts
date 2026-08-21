/**
 * Store-visual taxonomy — the not-product-scoped half of Package 3. See
 * docs/store-visuals.md.
 *
 * Kept as an independent string-literal union (not imported from
 * `@prisma/client`) for the same reason `services/generation/types.ts`'s
 * `GENERATION_TYPES` is — pure, no-I/O modules in this domain don't need a
 * Prisma import. Must mirror `prisma/schema.prisma`'s `StoreVisualType`
 * enum exactly — see tests/unit/store-visuals/types.test.ts.
 */
export const STORE_VISUAL_TYPES = ["HOMEPAGE_HERO", "COLLECTION_BANNER", "STORE_CTA"] as const;
export type StoreVisualTypeValue = (typeof STORE_VISUAL_TYPES)[number];

// Aspect ratio is fully shared with services/generation/ — re-exported here
// so this domain's own modules don't need to reach into a sibling domain
// for a type they use constantly, without duplicating the source of truth.
export { ASPECT_RATIOS, type AspectRatioValue } from "../generation/types";
