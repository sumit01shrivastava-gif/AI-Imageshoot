/**
 * Shared, provider-agnostic prompt composition — turns a `GenerateImageInput`
 * into the final text sent to a real vendor. Used by every real provider
 * (`OpenAIImageGenerationProvider`, `ProductionImageGenerationProvider`)
 * so the "what goes into the actual model call" logic lives in one
 * place, not duplicated per-vendor.
 *
 * `input.creativeDirection.prompt` (built by
 * services/generation/build-plan.ts / services/creative-studio/plan-builder.ts)
 * is ALREADY a fully-synthesized sentence — category, scene, style,
 * identity-preservation instruction, creative-override "this change is
 * permitted" clause, etc. are all baked in there (see
 * docs/creative-studio.md "Identity preservation" / "Creative
 * overrides"). This module adds exactly one more thing on top: the
 * product's own real catalog facts (`productFacts.title`/`description`/
 * `attributes`, added so a provider genuinely knows what the product IS,
 * not just an anonymous photo to transform) as a short grounding prefix,
 * plus negative constraints as an explicit "avoid" clause.
 *
 * `productFacts` arrives here as `Record<string, unknown>` — this file
 * intentionally stays in `services/ai/` (never imports
 * `services/generation`'s concrete `ProductFacts`/`GenerationPlan`
 * shape, per CLAUDE.md's domain-boundary rule), so every field is read
 * defensively with runtime type guards; a plan that doesn't populate
 * these fields (or an older/malformed one) degrades to "no grounding
 * prefix," never throws.
 */
import type { GenerateImageInput } from "./types";

interface ExtractedProductFacts {
  title: string | null;
  description: string | null;
  productType: string | null;
}

function extractProductFacts(productFacts: Record<string, unknown>): ExtractedProductFacts {
  const title = typeof productFacts.title === "string" ? productFacts.title : null;
  const description = typeof productFacts.description === "string" ? productFacts.description : null;

  const attributes = productFacts.attributes;
  const productType =
    attributes !== null && typeof attributes === "object" && "productType" in attributes && typeof (attributes as { productType: unknown }).productType === "string"
      ? (attributes as { productType: string }).productType
      : null;

  return { title, description, productType };
}

/**
 * A short "Product: {title} ({type})." + short description grounding
 * line — empty string when neither is available (a plan that didn't
 * populate `productFacts.title`/`description`, e.g. an older/malformed
 * one). Exported separately from `composeProviderPrompt` so a provider
 * whose contract has its own dedicated `negative_prompt` field (rather
 * than one merged `prompt` string) can prepend just this grounding piece
 * without also re-merging negative constraints into `prompt` — see
 * `ProductionImageGenerationProvider`, which keeps `negative_prompt`
 * separate.
 */
export function composeProductGroundingPrefix(productFacts: Record<string, unknown>): string {
  const { title, description, productType } = extractProductFacts(productFacts);
  const parts: string[] = [];
  if (title) parts.push(`Product: ${title}${productType ? ` (${productType})` : ""}.`);
  if (description) parts.push(description);
  return parts.length > 0 ? `${parts.join(" ")} ` : "";
}

/**
 * PRODUCT FIDELITY quality-floor pass: a compact, structural "reference
 * product = source of truth" instruction, added whenever this request
 * has a REAL reference/source image to ground against (never for a
 * from-scratch text-to-image request with nothing uploaded/selected —
 * there is no photo to be faithful to, and asserting fidelity to nothing
 * would be a meaningless, confusing instruction). Deliberately generic —
 * this module stays domain-agnostic (`services/ai/` — see CLAUDE.md's
 * architecture principles), so this is a universal POLICY statement,
 * applied identically to every generationType and every real provider,
 * not a restatement of whatever domain-specific preservation instruction
 * (services/creative-studio/identity-constraints.ts, or
 * services/generation/build-plan.ts's `PRESERVE_PRODUCT_INSTRUCTION`)
 * `creativeDirection.prompt` may already carry — those state WHICH
 * specific facts (this product's real material/color/hardware/...) must
 * hold; this states the DECISION-HIERARCHY boundary itself: creative
 * freedom governs the scene around the product, never the product. Kept
 * short (a handful of short clauses, not a paragraph) — see "avoid
 * prompt bloat" in this project's own instructions; reinforcement of a
 * non-negotiable boundary at the provider layer is not the same as
 * redundant prose.
 */
export function composeProductFidelityInstruction(hasReferenceImage: boolean): string {
  if (!hasReferenceImage) return "";
  return (
    "REFERENCE PRODUCT = SOURCE OF TRUTH: the attached reference image(s) show the exact physical product, " +
    "not creative inspiration. Preserve exactly: silhouette, proportions, geometry, relative scale, colors, " +
    "materials, finishes, textures, stones and decorative elements, patterns, logos, labels, typography, and " +
    "packaging structure. Creative freedom applies to environment, background, lighting, camera, atmosphere, " +
    "styling, model, and composition — never to product identity, structure, details, branding, colors/materials, " +
    "or proportions. "
  );
}

/** Whether `input` has any real image to ground a generation against —
 * shared by `composeProviderPrompt` and any provider that wants to
 * decide this the same way (see `composeProductFidelityInstruction`'s
 * doc comment). Mirrors the same "referenceImages first, sourceImages
 * fill in" precedence every real provider's own reference-resolution
 * already uses — this function doesn't need to pick between them, only
 * whether either is non-empty. */
export function hasReferenceImages(input: GenerateImageInput): boolean {
  return (input.referenceImages?.length ?? 0) > 0 || input.sourceImages.length > 0;
}

/**
 * Builds the final, single-string prompt: the product-fidelity
 * instruction (when a real reference image exists), the product
 * grounding prefix, the already-synthesized creative-direction prompt,
 * and an explicit "Avoid: ..." clause for negative constraints — for a
 * provider contract (like OpenAI's) with exactly one `prompt` field and
 * no separate negative-prompt parameter. Never includes raw
 * merchant-typed free text beyond what `creativeDirection.prompt`
 * itself already synthesized (see that field's own construction —
 * CLAUDE.md "no arbitrary prompts").
 */
export function composeProviderPrompt(input: GenerateImageInput): string {
  const negativeConstraints = input.creativeDirection.negativeConstraints ?? [];
  const fidelityInstruction = composeProductFidelityInstruction(hasReferenceImages(input));
  const parts: string[] = [];
  if (fidelityInstruction) parts.push(fidelityInstruction.trim());
  const grounding = composeProductGroundingPrefix(input.productFacts).trim();
  if (grounding) parts.push(grounding);
  // Creative Studio plans persist a rich identity instruction for
  // traceability, while this provider prompt already carries the same
  // source-of-truth policy above. Remove only those known leading
  // identity paragraphs so the image model receives a compact hierarchy;
  // the actual scene, interaction, and creative direction remain intact.
  const direction = compactCreativeDirection(input.creativeDirection.prompt);
  if (direction) parts.push(direction);
  if (negativeConstraints.length > 0) parts.push(`CRITICAL AVOIDS — Avoid: ${negativeConstraints.slice(0, 6).join(", ")}.`);
  return parts.join(" ");
}

function compactCreativeDirection(prompt: string): string {
  const patterns = [
    /^.*?Every other aspect of the product must remain exactly as shown\.\s*/is,
    /^.*?which take precedence over how they appear in the original image\.\s*/is,
    /^.*?generate a new image based only on the instructions below\.\s*/is,
  ];
  for (const pattern of patterns) {
    const compacted = prompt.replace(pattern, "").trim();
    if (compacted !== prompt.trim()) return compacted;
  }
  return prompt.trim();
}
