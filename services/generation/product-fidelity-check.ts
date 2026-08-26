/**
 * PRODUCT FIDELITY quality-floor pass — the "final internal generation
 * check" this pass's own instructions ask for: a lightweight, entirely
 * DETERMINISTIC structural consistency check run against the
 * already-built `GenerationPlan`, right before it's returned/persisted.
 * Deliberately NOT a second LLM call and NOT a gate that blocks
 * generation — a real vision-capable semantic check (does the pixel
 * output actually match the reference?) is exactly the same "not yet
 * possible without a vision-capable provider" boundary
 * services/generation/identity-validation.server.ts already documents
 * honestly; this check validates the STRUCTURED REQUEST that's about to
 * be sent, not the eventual image. Every field below is derived purely
 * from data already computed by build-plan.ts/plan-builder.ts — no new
 * reasoning, no chain-of-thought, nothing exposed to the merchant. The
 * result is logged (safe booleans/counts only, mirroring
 * services/creative-studio/session.server.ts's existing
 * `creative_studio.plan.built` diagnostic pattern) so a real regression
 * (e.g. a future edit that silently breaks the environment/scene wiring)
 * is observable in production logs, not just when a test happens to
 * cover it.
 */
import type { GenerationPlan } from "./schema";

export interface ProductFidelityCheck {
  referenceProductPresent: boolean;
  productFidelityRequired: boolean;
  productIdentityPreserved: boolean;
  userExplicitInstructionsPreserved: boolean;
  /** `true` when no model was requested (nothing to validate) OR a model
   * was requested and the synthesized prompt actually carries a real
   * interaction verb (see services/generation/product-interaction.ts) —
   * `false` only for the genuine regression this exists to catch: a
   * model-imagery request whose prompt never actually says how the
   * model relates to the product at all. */
  productModelInteractionValid: boolean;
  productVisibilityAdequate: boolean;
  negativeConstraintsPresent: boolean;
}

const INTERACTION_VERB_PATTERN = /\b(wearing|holding|held|hold|using|use|pouring|pour|serving|serve|displaying|display)\b/i;
const MODEL_INTENTS = new Set(["ADD_MODEL", "CHANGE_MODEL"]);

/** Checks a built `GenerationPlan` for internal product-fidelity
 * consistency — never throws (a check that could itself break
 * generation would be worse than no check at all); every field is a
 * plain boolean derived from data already on `plan`. */
export function checkProductFidelity(plan: GenerationPlan): ProductFidelityCheck {
  const referenceProductPresent = plan.sourceImages.length > 0 || plan.referenceImages.length > 0;
  const prompt = plan.creativeDirection.prompt.toLowerCase();

  // Both services/generation/build-plan.ts's PRESERVE_PRODUCT_INSTRUCTION
  // and services/creative-studio/identity-constraints.ts's instruction
  // deliberately share this exact phrase (see both files' own product
  // -fidelity doc comments) specifically so this check has one reliable,
  // structural signal to look for regardless of which path built the
  // plan.
  const productIdentityPreserved = !referenceProductPresent || prompt.includes("source of truth");

  // A structural sanity check, not a re-derivation: when Creative
  // Studio's own parsed intent explicitly specified a dimension, the
  // plan's creativeDirection must reflect the SAME value — catches a
  // real class of regression (a future edit that lets the Creative
  // Director's own inference silently override an explicit field)
  // without needing the original ParsedIntent here at all.
  const creative = plan.creativeIntent?.creative;
  const userExplicitInstructionsPreserved =
    !creative ||
    ((creative.scene === null || creative.scene === plan.creativeDirection.environment) &&
      (creative.lighting === null || creative.lighting === plan.creativeDirection.lighting) &&
      (creative.composition === null || creative.composition === plan.creativeDirection.composition));

  const modelRequested = plan.generationType === "MODEL_SHOOT" || (plan.creativeIntent ? MODEL_INTENTS.has(plan.creativeIntent.intent) : false);
  const productModelInteractionValid = !modelRequested || INTERACTION_VERB_PATTERN.test(prompt);

  // A genuinely pathological case: a negative constraint naming the
  // product's own category would hide the very thing this shoot exists
  // to show. Deliberately narrow (not a general "is the product visible"
  // judgment, which needs real vision) — an honest structural guard, not
  // a simulated visual check.
  const productVisibilityAdequate = !(
    plan.category && plan.creativeDirection.negativeConstraints.some((c) => c.toLowerCase().includes(plan.category!.toLowerCase()))
  );

  return {
    referenceProductPresent,
    productFidelityRequired: referenceProductPresent,
    productIdentityPreserved,
    userExplicitInstructionsPreserved,
    productModelInteractionValid,
    productVisibilityAdequate,
    negativeConstraintsPresent: plan.creativeDirection.negativeConstraints.length > 0,
  };
}
