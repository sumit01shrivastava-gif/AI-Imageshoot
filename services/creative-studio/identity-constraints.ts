/**
 * Turns Product Intelligence's `IdentityAnchors` (+ basic product
 * metadata) into an explicit, structural "the product is the immutable
 * subject" constraint set — Part 4's central requirement, made real
 * rather than only prose.
 *
 * Deliberately independent of whatever the intent parser returned:
 * `ParsedIntent.preserveHints` (services/creative-studio/intent-schema.ts)
 * is supplementary — a heuristic (or future real) parser noticing the
 * merchant said "keep it exactly the same" is a nice-to-have signal, but
 * the REAL, non-negotiable preservation set below is derived unconditionally
 * from the product's own analyzed facts, every single request, whether
 * or not the merchant mentioned preservation at all. A parser must never
 * be the only thing standing between a request and the product being
 * redesigned — see docs/creative-studio.md "Identity preservation".
 *
 * Pure, no I/O — mirrors services/generation/build-plan.ts's
 * `synthesizePrompt` in spirit, scoped to just this one concern.
 */
import type { IdentityAnchors } from "../intelligence/schema";

export interface AttributeOverrides {
  color: string | null;
  material: string | null;
}

export interface IdentityConstraints {
  /** Human-readable facts the generation must not contradict — e.g.
   * "category: Handbags", "material: Leather", "primary color: Brown",
   * "distinctive hardware: gold clasp". Only non-null/non-empty anchors
   * are included — an anchor Product Intelligence never determined isn't
   * asserted as a constraint (nothing to preserve that was never
   * observed). An attribute the merchant explicitly overrode (see
   * `overridden` below) is EXCLUDED from this list — it is no longer
   * asserted as immutable for this request. */
  immutable: string[];
  /** The specific overrides this request was granted, structurally
   * (never by string-editing `immutable`/`instruction`) — e.g.
   * `{ color: "black" }` for "make the bottle black". Empty when no
   * override was requested. See intent-schema.ts's `attributeOverrides`
   * doc comment for the full "creative override" mechanism this
   * implements (Part 2). */
  overridden: Partial<AttributeOverrides>;
  /** The itemized, assembled "do not..." instruction appended to every
   * synthesized Creative Studio prompt — see plan-builder.ts. Includes an
   * explicit "permitted change" clause for anything in `overridden`. */
  instruction: string;
}

const CATEGORY_ITEMS = [
  "its shape and proportions",
  "its packaging",
  "any visible logos",
  "any visible labels or text printed on the product",
  "its exact material",
  "its exact color",
] as const;

/**
 * Builds the structural identity constraints for one generation request.
 * `productName` is used only to make the instruction concrete/readable
 * (e.g. "the Studio Sofa") — never as a place to smuggle merchant-typed
 * free text into the prompt (it's Shopify's own product title, already
 * trusted product metadata, not conversational input).
 */
export function buildIdentityConstraints(
  anchors: IdentityAnchors,
  productName: string,
  overrides: Partial<AttributeOverrides> = {},
): IdentityConstraints {
  const colorOverride = overrides.color ?? null;
  const materialOverride = overrides.material ?? null;

  const immutable: string[] = [`category: ${anchors.category}`];
  if (anchors.shape) immutable.push(`shape: ${anchors.shape}`);
  // A merchant-overridden attribute is deliberately EXCLUDED from the
  // immutable set — structurally (a field-level `if`), never by
  // searching-and-stripping a generated sentence (see module doc
  // comment's "no fragile string replacement").
  if (anchors.material && !materialOverride) immutable.push(`material: ${anchors.material}`);
  if (anchors.primaryColor && !colorOverride) immutable.push(`primary color: ${anchors.primaryColor}`);
  for (const detail of anchors.constructionDetails) immutable.push(`construction: ${detail}`);
  for (const hardware of anchors.distinctiveHardware) immutable.push(`hardware: ${hardware}`);
  if (anchors.brandingVisible) {
    immutable.push(anchors.brandingDescription ? `branding: ${anchors.brandingDescription}` : "branding: visible, exact branding present");
  }

  // "The Studio Tote is..." for a real title, "The product is..." when
  // none was given — never "The the product is..." (a real, once-caught
  // double-article bug; see tests/unit/creative-studio/identity-constraints.test.ts).
  const subjectPhrase = productName.trim() ? `The ${productName.trim()}` : "The product";
  const overriddenItems = [
    colorOverride ? `its color (change to ${colorOverride})` : null,
    materialOverride ? `its material (change to ${materialOverride})` : null,
  ].filter((item): item is string => item !== null);
  const remainingCategoryItems = CATEGORY_ITEMS.filter((item) => {
    if (colorOverride && item === "its exact color") return false;
    if (materialOverride && item === "its exact material") return false;
    return true;
  });

  const instruction =
    `${subjectPhrase} is the immutable subject of this image and must be preserved exactly as shown in the ` +
    `source image: do not redesign it, invent missing components, or replace it with a visually similar ` +
    `object. Unless explicitly requested, do not alter ${remainingCategoryItems.join(", ")}.` +
    (overriddenItems.length > 0
      ? ` The merchant has explicitly requested the following change${overriddenItems.length > 1 ? "s" : ""}, which ` +
        `${overriddenItems.length > 1 ? "are" : "is"} permitted: ${overriddenItems.join(", ")}. Every other aspect of the ` +
        `product must remain exactly as shown.`
      : "");

  return { immutable, overridden: { color: colorOverride, material: materialOverride }, instruction };
}

/** Terms that name a protected brand/identity element — mirrors
 * `CATEGORY_ITEMS`'s unconditional "any visible logos"/"any visible
 * labels or text printed on the product" protection above (that
 * protection applies to every product, not only when Product
 * Intelligence explicitly flagged `brandingVisible` — a false negative
 * there must never become a way to strip branding). Deliberately a
 * small, named keyword list, not a general classifier — same "narrow,
 * structural, not fragile string search" spirit as the color/material
 * override mechanism. */
const PROTECTED_REMOVAL_TERMS = /\b(logo|brand(?:ing)?|trademark|watermark|wordmark|label)\b/i;

/**
 * Splits a requested `removeElements` list into what's safe to actually
 * ask the provider to remove and what must be silently held back because
 * it names a protected identity/branding element — e.g. "Remove the
 * logo" (Part 4 worked example). Never lets a "remove X" request reach
 * the synthesized prompt when X is exactly what the identity instruction,
 * two sentences earlier, told the model to preserve — that self
 * -contradiction is what would otherwise invite the model to comply with
 * whichever clause it weighted more. `blocked` is returned (not just
 * dropped) so a caller can still record/surface that the request was
 * declined rather than silently no-op'd — see plan-builder.ts and
 * services/creative-studio/session.server.ts's `assistantAcknowledgement`.
 */
export function filterProtectedRemovals(removeElements: string[]): { allowed: string[]; blocked: string[] } {
  const allowed: string[] = [];
  const blocked: string[] = [];
  for (const item of removeElements) {
    (PROTECTED_REMOVAL_TERMS.test(item) ? blocked : allowed).push(item);
  }
  return { allowed, blocked };
}
