/**
 * Category → generation-recommendation lookup.
 *
 * Pure, data-driven reference table (no I/O) — deliberately NOT a chain of
 * per-category `if`/`switch` conditionals, so adding a category is adding
 * one table row, not another branch (see the Phase 2 instructions
 * "maintainable category/recommendation architecture").
 *
 * Two consumers:
 *   - `services/intelligence/deterministic-test-provider.server.ts` uses
 *     this to build realistic canned output for tests.
 *   - A real (future) `AIProvider` implementation can use this as prompt
 *     grounding / a sanity default; it is NOT force-applied over a
 *     provider's own validated output — `services/intelligence/schema.ts`
 *     already requires `recommendedAssetTypes`/`modelSuitable` from every
 *     provider, so this table's role is reference, not override.
 *
 * See docs/product-intelligence.md "Generation recommendations" and
 * "Model suitability" for the worked examples this table encodes
 * (jewelry/furniture/shoes/food, ...).
 *
 * Phase 5 (docs/lifestyle-generation.md) added a third consumer:
 * `services/generation/lifestyle-scene.ts` uses the same
 * `getCategoryRecommendation` lookup for category-aware lifestyle scene
 * defaults (`recommendedSurfaces`/`recommendedProps`/`recommendedMood`/
 * `recommendedColorDirection` below) — reusing this table rather than a
 * second, parallel category-matching table, per CLAUDE.md "Do not create
 * unnecessary normalization tables"/"don't duplicate Product
 * Intelligence".
 */

/** Kept intentionally small and reusable — the same handful of asset
 * shapes apply across very different product categories; what varies is
 * which ones are recommended and in what order. */
export const ASSET_TYPES = [
  "product_studio",
  "lifestyle",
  "model_shoot",
  "detail",
  "packaging",
  "scene",
] as const;

export type AssetType = (typeof ASSET_TYPES)[number];

export interface CategoryRecommendation {
  recommendedAssetTypes: AssetType[];
  modelSuitable: boolean;
  recommendedEnvironments: string[];
  recommendedPoseTypes: string[];
  /** Lifestyle-scene defaults (Phase 5) — see
   * services/generation/lifestyle-scene.ts. Optional so this table's
   * Phase 2 role (asset-type/pose recommendation) stays unaffected for
   * any consumer that doesn't care about these. */
  recommendedSurfaces?: string[];
  recommendedProps?: string[];
  recommendedMood?: string;
  recommendedColorDirection?: string;
}

interface CategoryProfile extends CategoryRecommendation {
  /** Matched case-insensitively as a substring against the category
   * signal (Shopify category / productType / AI-inferred category, title
   * keywords, ...). First match wins. */
  matchKeywords: string[];
}

/**
 * One row per known category family. Order matters — first match wins —
 * so more specific keywords should come before more general ones.
 */
const CATEGORY_PROFILES: CategoryProfile[] = [
  {
    matchKeywords: ["jewelry", "jewellery", "ring", "necklace", "earring", "bracelet", "pendant"],
    recommendedAssetTypes: ["product_studio", "lifestyle", "model_shoot", "detail"],
    modelSuitable: true,
    recommendedEnvironments: ["studio", "luxury lifestyle setting"],
    recommendedPoseTypes: ["hand close-up", "worn detail"],
    recommendedSurfaces: ["velvet", "polished marble"],
    recommendedProps: ["soft draped fabric", "delicate flowers"],
    recommendedMood: "elegant, luxurious",
    recommendedColorDirection: "deep, rich tones with soft highlights",
  },
  {
    matchKeywords: ["eyewear", "glasses", "sunglasses", "spectacles"],
    recommendedAssetTypes: ["product_studio", "model_shoot", "detail", "lifestyle"],
    modelSuitable: true,
    recommendedEnvironments: ["studio", "outdoor lifestyle"],
    recommendedPoseTypes: ["face close-up", "worn detail"],
    recommendedSurfaces: ["matte surface", "outdoor setting"],
    recommendedProps: ["natural sunlight"],
    recommendedMood: "confident, modern",
    recommendedColorDirection: "natural, sunlit tones",
  },
  {
    matchKeywords: ["handbag", "backpack", "purse", "tote", "luggage", "wallet"],
    recommendedAssetTypes: ["product_studio", "lifestyle", "model_shoot", "detail"],
    modelSuitable: true,
    recommendedEnvironments: ["studio", "lifestyle setting"],
    recommendedPoseTypes: ["carried/worn detail"],
    recommendedSurfaces: ["polished marble", "wood table", "leather bench"],
    recommendedProps: ["folded scarf", "sunglasses"],
    recommendedMood: "sophisticated, aspirational",
    recommendedColorDirection: "warm neutrals",
  },
  {
    matchKeywords: ["shoe", "footwear", "sneaker", "boot", "sandal", "heel"],
    recommendedAssetTypes: ["product_studio", "lifestyle", "model_shoot", "detail"],
    modelSuitable: true,
    recommendedEnvironments: ["studio", "street", "lifestyle"],
    recommendedPoseTypes: ["worn full-body", "worn detail"],
    recommendedSurfaces: ["concrete", "wood floor", "pavement"],
    recommendedProps: ["urban backdrop"],
    recommendedMood: "energetic, dynamic",
    recommendedColorDirection: "bold, contrast-rich",
  },
  {
    matchKeywords: [
      "clothing",
      "apparel",
      "shirt",
      "dress",
      "jacket",
      "pants",
      "skirt",
      "sweater",
      "coat",
    ],
    recommendedAssetTypes: ["product_studio", "model_shoot", "lifestyle", "detail"],
    modelSuitable: true,
    recommendedEnvironments: ["studio", "street", "lifestyle"],
    recommendedPoseTypes: ["worn full-body", "worn detail"],
    recommendedSurfaces: ["street", "studio backdrop"],
    recommendedProps: [],
    recommendedMood: "natural, candid",
    recommendedColorDirection: "true-to-life color",
  },
  {
    matchKeywords: ["furniture", "sofa", "chair", "table", "desk", "shelf", "cabinet", "bed"],
    recommendedAssetTypes: ["product_studio", "scene", "detail"],
    modelSuitable: false,
    recommendedEnvironments: ["studio", "living room", "room scene"],
    recommendedPoseTypes: [],
    recommendedSurfaces: ["room floor", "area rug"],
    recommendedProps: ["potted plant", "throw pillow", "reading lamp"],
    recommendedMood: "cozy, inviting",
    recommendedColorDirection: "warm, homey tones",
  },
  {
    matchKeywords: ["appliance", "kitchen", "blender", "toaster", "microwave", "cookware"],
    recommendedAssetTypes: ["product_studio", "scene", "detail"],
    modelSuitable: false,
    recommendedEnvironments: ["studio", "kitchen scene"],
    recommendedPoseTypes: [],
    recommendedSurfaces: ["kitchen countertop"],
    recommendedProps: ["fresh ingredients", "kitchen towel"],
    recommendedMood: "clean, functional",
    recommendedColorDirection: "bright, crisp tones",
  },
  {
    matchKeywords: [
      "electronics",
      "device",
      "gadget",
      "headphone",
      "speaker",
      "laptop",
      "phone",
      "camera",
    ],
    recommendedAssetTypes: ["product_studio", "detail", "scene"],
    modelSuitable: false,
    recommendedEnvironments: ["studio", "desk scene"],
    recommendedPoseTypes: [],
    recommendedSurfaces: ["minimalist desk"],
    recommendedProps: ["notebook", "coffee cup"],
    recommendedMood: "sleek, modern",
    recommendedColorDirection: "cool, neutral tones",
  },
  {
    matchKeywords: ["food", "snack", "beverage", "drink", "grocery", "coffee", "tea"],
    recommendedAssetTypes: ["product_studio", "scene", "packaging"],
    modelSuitable: false,
    recommendedEnvironments: ["studio", "serving scene", "table scene"],
    recommendedPoseTypes: [],
    recommendedSurfaces: ["wood table", "linen cloth"],
    recommendedProps: ["fresh ingredients", "rustic dishware"],
    recommendedMood: "appetizing, warm",
    recommendedColorDirection: "warm, natural tones",
  },
];

/** Reasonable fallback for a category that matches nothing above — never
 * throws, always returns a usable recommendation. */
const DEFAULT_RECOMMENDATION: CategoryRecommendation = {
  recommendedAssetTypes: ["product_studio", "detail"],
  modelSuitable: false,
  recommendedEnvironments: ["studio"],
  recommendedPoseTypes: [],
  recommendedSurfaces: ["neutral surface"],
  recommendedProps: [],
  recommendedMood: "clean, professional",
  recommendedColorDirection: "neutral tones",
};

/**
 * Looks up a generation recommendation for a free-text category signal
 * (e.g. a Shopify category, product type, or title). Case-insensitive
 * substring match against each profile's keywords; first match wins.
 */
export function getCategoryRecommendation(categorySignal: string): CategoryRecommendation {
  const normalized = categorySignal.toLowerCase();
  const profile = CATEGORY_PROFILES.find((candidate) =>
    candidate.matchKeywords.some((keyword) => normalized.includes(keyword)),
  );

  if (!profile) return DEFAULT_RECOMMENDATION;

  const { matchKeywords: _matchKeywords, ...recommendation } = profile;
  void _matchKeywords;
  return recommendation;
}
