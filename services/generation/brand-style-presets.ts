/**
 * Built-in brand style preset catalog — see
 * docs/lifestyle-generation.md "Brand style presets".
 *
 * A named, reusable lifestyle generation configuration. Deliberately a
 * code constant table, not seeded database rows: every shop gets these
 * for free with zero migration cost, they're trivially versionable in
 * code, and they never need per-shop persistence — only a merchant's own
 * CUSTOM presets are `BrandStylePreset` rows (see
 * db/repositories/brand-style-preset.repository.ts). Mirrors
 * services/intelligence/category-recommendations.ts's "pure, data-driven
 * reference table" pattern.
 */
import { BrandStylePresetAttributesSchema, type BrandStylePresetAttributes } from "./schema";

export interface BrandStylePresetSummary {
  id: string;
  name: string;
  description: string;
  attributes: BrandStylePresetAttributes;
}

/**
 * The six named presets called out in the Phase 5 instructions. Each
 * `attributes` value is validated once, at module load, against
 * `BrandStylePresetAttributesSchema` — the same gate a merchant's own
 * custom preset attributes go through (see
 * services/generation/brand-style-preset.server.ts) — so a typo here
 * fails loudly at boot/import time, never silently.
 */
const BUILT_IN_PRESET_DEFINITIONS: Array<Omit<BrandStylePresetSummary, "attributes"> & { attributes: unknown }> = [
  {
    id: "minimal-studio",
    name: "Minimal Studio",
    description: "Clean, uncluttered studio backgrounds with soft, even lighting.",
    attributes: {
      visualTone: "minimal, uncluttered",
      photographyStyle: "studio product photography",
      backgroundStyle: "seamless neutral backdrop",
      lightingStyle: "soft, even studio lighting",
      compositionStyle: "centered, generous negative space",
      environment: "minimal studio",
      surface: "neutral seamless surface",
      mood: "clean, professional",
      colorDirection: "neutral, muted tones",
      negativeConstraints: ["cluttered background", "harsh shadows", "busy props"],
    },
  },
  {
    id: "luxury-editorial",
    name: "Luxury Editorial",
    description: "High-end editorial styling with dramatic lighting and rich materials.",
    attributes: {
      visualTone: "luxurious, editorial",
      photographyStyle: "high-fashion editorial",
      backgroundStyle: "rich textured backdrop",
      lightingStyle: "dramatic, directional lighting",
      compositionStyle: "asymmetric, editorial framing",
      luxuryLevel: "high",
      environment: "upscale interior",
      surface: "polished marble",
      props: ["soft draped fabric", "fresh flowers"],
      mood: "elegant, aspirational",
      colorDirection: "deep, rich tones with soft highlights",
      negativeConstraints: ["cheap-looking props", "flat lighting"],
    },
  },
  {
    id: "natural-lifestyle",
    name: "Natural Lifestyle",
    description: "Candid, sunlit scenes that feel authentic and everyday.",
    attributes: {
      visualTone: "natural, authentic",
      photographyStyle: "candid lifestyle photography",
      backgroundStyle: "natural indoor or outdoor setting",
      lightingStyle: "soft natural daylight",
      compositionStyle: "relaxed, candid framing",
      environment: "sunlit home interior",
      surface: "wood table",
      mood: "warm, natural, everyday",
      colorDirection: "warm, true-to-life tones",
      negativeConstraints: ["studio backdrop", "artificial lighting"],
    },
  },
  {
    id: "premium-modern",
    name: "Premium Modern",
    description: "Sleek, contemporary scenes with confident, modern styling.",
    attributes: {
      visualTone: "sleek, contemporary",
      photographyStyle: "modern commercial photography",
      backgroundStyle: "minimalist modern interior",
      lightingStyle: "crisp, directional lighting",
      compositionStyle: "clean geometric framing",
      luxuryLevel: "medium-high",
      environment: "modern interior",
      surface: "polished concrete",
      mood: "confident, modern",
      colorDirection: "cool, contemporary tones",
      negativeConstraints: ["cluttered scene", "vintage styling"],
    },
  },
  {
    id: "warm-lifestyle",
    name: "Warm Lifestyle",
    description: "Cozy, inviting scenes with warm tones and soft textures.",
    attributes: {
      visualTone: "cozy, inviting",
      photographyStyle: "warm lifestyle photography",
      backgroundStyle: "textured cozy interior",
      lightingStyle: "warm golden-hour lighting",
      compositionStyle: "relaxed, homey framing",
      environment: "cozy living space",
      surface: "linen textile",
      props: ["soft throw blanket", "warm ambient light"],
      mood: "warm, comforting",
      colorDirection: "warm amber and neutral tones",
      negativeConstraints: ["cold lighting", "sterile backdrop"],
    },
  },
  {
    id: "clean-commercial",
    name: "Clean Commercial",
    description: "Bright, straightforward commercial styling built for clarity.",
    attributes: {
      visualTone: "bright, straightforward",
      photographyStyle: "commercial product photography",
      backgroundStyle: "bright neutral backdrop",
      lightingStyle: "bright, even commercial lighting",
      compositionStyle: "clear, balanced framing",
      environment: "bright commercial setting",
      surface: "clean neutral surface",
      mood: "clean, functional, trustworthy",
      colorDirection: "bright, crisp tones",
      negativeConstraints: ["moody lighting", "dark shadows"],
    },
  },
];

/** Validated once at module load — see `BUILT_IN_PRESET_DEFINITIONS`'s
 * doc comment for why a malformed built-in preset should fail loudly
 * rather than silently at first use. */
export const BRAND_STYLE_PRESETS: BrandStylePresetSummary[] = BUILT_IN_PRESET_DEFINITIONS.map((preset) => ({
  ...preset,
  attributes: BrandStylePresetAttributesSchema.parse(preset.attributes),
}));

const BUILT_IN_PRESETS_BY_ID = new Map(BRAND_STYLE_PRESETS.map((preset) => [preset.id, preset]));

export function getBuiltInPreset(id: string): BrandStylePresetSummary | null {
  return BUILT_IN_PRESETS_BY_ID.get(id) ?? null;
}

export function isBuiltInPresetId(id: string): boolean {
  return BUILT_IN_PRESETS_BY_ID.has(id);
}
