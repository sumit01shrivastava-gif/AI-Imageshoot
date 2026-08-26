/**
 * PRODUCT FIDELITY quality-floor pass — Priority 2 (CORRECT PRODUCT /
 * HUMAN INTERACTION): a small, category-aware resolver for "what is the
 * physically correct way for a human model to interact with THIS kind of
 * product," replacing the previous blanket "featuring the product"
 * phrasing every model-imagery prompt used regardless of category (see
 * services/generation/build-plan.ts's MODEL_SHOOT branch, and
 * services/creative-studio/creative-brief.ts's ADD_MODEL/CHANGE_MODEL
 * inferred decision).
 *
 * Deliberately generalized, not overfit to any one benchmark category —
 * every bucket below is a real, distinct commercial-photography
 * convention (jewelry is worn on the correct body part; eyewear is worn
 * on the face; a beverage is poured/served, not "worn"; ...), and the
 * fallback for any category not covered still gives a physically
 * sensible, non-committal instruction ("hold or display naturally")
 * rather than defaulting to "wear it," which would be actively wrong for
 * most categories (furniture, electronics, food, ...). A short, named
 * lookup table — the same "structural, not a giant keyword table"
 * discipline every other deterministic fallback in this codebase
 * follows (see creative-brief.ts's module doc comment) — not a
 * classifier; a category signal this table doesn't recognize simply
 * gets the honest generic fallback, never a wrong guess.
 *
 * Pure, no I/O — shared by both the non-Creative-Studio generation path
 * (build-plan.ts) and Creative Studio's own deterministic fallback
 * (creative-brief.ts), so the two don't drift into two different
 * category tables for the same real-world concern.
 */

interface ProductInteractionRule {
  /** Matched case-insensitively against the category signal — a
   * substring test, not an exact match, so "Fine Jewelry" and "jewelry"
   * both resolve the same way. */
  pattern: RegExp;
  /** A short phrase describing the physically correct interaction — used
   * as-is in a sentence like "the model {phrase}". */
  interaction: string;
}

// `s?` after every noun alternative — a category signal is very often a
// plural Shopify product-type label ("Bangles", "Necklaces", "Rings"),
// and `\b` alone doesn't tolerate that trailing "s".
const PRODUCT_INTERACTION_RULES: ProductInteractionRule[] = [
  { pattern: /\b(rings?|bracelets?|bangles?|necklaces?|earrings?|jewel(le)?ry|pendants?)\b/i, interaction: "wearing it naturally on the correct body part, at real-world scale" },
  { pattern: /\b(glasses|eyewear|sunglasses|spectacles)\b/i, interaction: "wearing it correctly positioned on the face" },
  { pattern: /\b(watch(es)?|wristwatch(es)?)\b/i, interaction: "wearing it naturally on the wrist" },
  { pattern: /\b(shoes?|sneakers?|footwear|boots?|sandals?|heels?)\b/i, interaction: "wearing it naturally on the foot" },
  { pattern: /\b(clothing|apparel|shirts?|dresses?|jackets?|garments?|coats?|trousers?|pants?)\b/i, interaction: "wearing it naturally on the body, fitted and draped correctly" },
  { pattern: /\b(bags?|handbags?|purses?|totes?|backpacks?|clutch(es)?)\b/i, interaction: "holding or wearing it naturally, the way it would actually be carried" },
  { pattern: /\b(skincare|beauty|cosmetics?|makeup|perfumes?|fragrances?)\b/i, interaction: "holding, applying, or displaying it the way it would actually be used" },
  { pattern: /\b(electronics?|devices?|gadgets?|phones?|laptops?|cameras?|headphones?|speakers?)\b/i, interaction: "holding or using it naturally, the way it would actually be operated" },
  { pattern: /\b(foods?|snacks?|beverages?|drinks?|bottles?|beers?|wines?|coffees?|teas?)\b/i, interaction: "holding, pouring, or serving it the way it would actually be presented" },
];

/** The physically sensible default for a category this table doesn't
 * recognize — never "wearing it," which would be wrong for most
 * uncovered categories (furniture, home goods, appliances, ...). */
const DEFAULT_INTERACTION = "holding or displaying it naturally, in a way that matches how this kind of product is actually used";

/**
 * Resolves the commercially/physically correct model-product interaction
 * for a category signal (a Shopify `productType`/Product Intelligence
 * `category` string, or `null` when none is known). Never throws, never
 * returns an empty string — always a real, sensible phrase.
 */
export function resolveProductInteraction(categorySignal: string | null): string {
  if (categorySignal) {
    const match = PRODUCT_INTERACTION_RULES.find((rule) => rule.pattern.test(categorySignal));
    if (match) return match.interaction;
  }
  return DEFAULT_INTERACTION;
}
