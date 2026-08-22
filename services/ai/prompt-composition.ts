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
 * Builds the final, single-string prompt: the product grounding prefix
 * above, the already-synthesized creative-direction prompt, and an
 * explicit "Avoid: ..." clause for negative constraints — for a
 * provider contract (like OpenAI's) with exactly one `prompt` field and
 * no separate negative-prompt parameter. Never includes raw
 * merchant-typed free text beyond what `creativeDirection.prompt`
 * itself already synthesized (see that field's own construction —
 * CLAUDE.md "no arbitrary prompts").
 */
export function composeProviderPrompt(input: GenerateImageInput): string {
  const negativeConstraints = input.creativeDirection.negativeConstraints ?? [];
  const parts: string[] = [`${composeProductGroundingPrefix(input.productFacts)}${input.creativeDirection.prompt}`];
  if (negativeConstraints.length > 0) parts.push(`Avoid: ${negativeConstraints.join(", ")}.`);
  return parts.join(" ");
}
