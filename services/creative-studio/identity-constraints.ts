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

/**
 * PRODUCT FIDELITY quality-floor pass: the uploaded/selected product is
 * the source-of-truth physical object, not creative inspiration — this
 * list is the concrete, unconditional expression of that ("never
 * casually redesign, simplify, substitute, or invent"). Expanded beyond
 * the original shape/packaging/logo/material/color set to cover every
 * category of fidelity risk a real commercial product photo can carry
 * (a ring's stones, a garment's pattern, a box's printed typography, a
 * gadget's exact geometry, ...) — still a short, generic, category
 * -agnostic list (never named per-product), not a giant table: the same
 * "structural, not a keyword lookup per category" discipline every other
 * deterministic fallback in this codebase already follows.
 */
const CATEGORY_ITEMS = [
  "its silhouette, shape and proportions",
  "its geometry and scale relative to a real object of this kind",
  "any visible logos",
  "any visible labels, typography, or text printed on the product",
  "its exact material",
  "its exact color",
  "its finish, texture, and surface detail",
  "any stones, gems, or decorative elements",
  "any pattern or print",
  "its distinctive features and hardware",
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
    `${subjectPhrase} is the immutable subject of this image and the source of truth for what it looks like — ` +
    `not creative inspiration — and must be preserved exactly as shown in the source image: do not redesign it, ` +
    `simplify it, substitute a visually similar object, invent missing components, or produce a "better looking" ` +
    `version of it. Unless explicitly requested, do not alter ${remainingCategoryItems.join(", ")}. ` +
    `Treat any source presentation box, display case, shipping packaging, prop, hand, surface, room, and background as replaceable scene context — not part of the product — unless the catalog facts or merchant explicitly identify it as part of what is being sold. Do not add fictional branding, logos, slogans, labels, or decorative typography.` +
    (overriddenItems.length > 0
      ? ` The merchant has explicitly requested the following change${overriddenItems.length > 1 ? "s" : ""}, which ` +
        `${overriddenItems.length > 1 ? "are" : "is"} permitted: ${overriddenItems.join(", ")}. Every other aspect of the ` +
        `product must remain exactly as shown.`
      : "");

  return { immutable, overridden: { color: colorOverride, material: materialOverride }, instruction };
}

/**
 * The standalone (no Shopify product, no Product Intelligence) counterpart
 * to `buildIdentityConstraints` above — see
 * services/creative-studio/plan-builder.ts's
 * `buildStandaloneCreativeGenerationPlan`. There is no `IdentityAnchors`
 * to build a real constraint set from (nothing has been analyzed), so
 * `immutable` stays permanently empty here — never fabricated to look
 * like a real, product-derived preservation list. When a reference image
 * DOES exist for this turn (an uploaded photo, or the session's own
 * previous result), reference-image fidelity is still asserted
 * structurally — the one form of "preserve what's there" that's honest
 * without any analyzed facts, mirroring `buildIdentityConstraints`'s own
 * reference-fidelity clause (built separately, in
 * plan-builder.ts's `synthesizeCreativePrompt`, from this function's
 * `instruction`).
 *
 * Deliberately scoped to IDENTITY/APPEARANCE, not "preserve the whole
 * image": a real, previously-fixed gap had this instruction say
 * "preserved exactly as shown, except for what is explicitly requested
 * below" — which is only as good as whatever ended up structurally
 * captured below, and pose/action had NOWHERE to go before
 * intent-schema.ts's `action` field existed, so a request like "make the
 * model perform yoga" silently lost the pose change and the model
 * received no counter-instruction to the implicit "preserve everything"
 * default. Identity preservation and pose/composition preservation are
 * different concepts (see docs/creative-studio.md "Preserve vs.
 * transform") — this instruction now says so explicitly, rather than
 * relying on every possible transformation being perfectly captured as
 * its own structured field first.
 */
export function buildStandaloneIdentityConstraints(
  hasReferenceImage: boolean,
  overrides: Partial<AttributeOverrides> = {},
): IdentityConstraints {
  const colorOverride = overrides.color ?? null;
  const materialOverride = overrides.material ?? null;

  const overriddenItems = [
    colorOverride ? `its color (change to ${colorOverride})` : null,
    materialOverride ? `its material (change to ${materialOverride})` : null,
  ].filter((item): item is string => item !== null);

  const instruction = hasReferenceImage
    ? `The uploaded reference image establishes this request's subject — preserve the subject's identity and defining visual characteristics exactly as shown (for a person: face, body, and distinguishing features; for an object: its shape, materials, and design). Everything else about how the subject is presented — pose, action, clothing, environment, background, lighting, and composition — should be reinterpreted according to the instructions below, which take precedence over how they appear in the original image.` +
      (overriddenItems.length > 0
        ? ` The merchant has explicitly requested the following change${overriddenItems.length > 1 ? "s" : ""}, which ` +
          `${overriddenItems.length > 1 ? "are" : "is"} permitted: ${overriddenItems.join(", ")}. Every other aspect of the subject's identity/appearance must remain exactly as shown.`
        : "")
    : `There is no existing image to preserve — generate a new image based only on the instructions below.`;

  return { immutable: [], overridden: { color: colorOverride, material: materialOverride }, instruction };
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
