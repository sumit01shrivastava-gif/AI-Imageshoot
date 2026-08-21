/**
 * Identity-validation boundary — see docs/lifestyle-generation.md
 * "Identity validation" for the full reasoning.
 *
 * IMPORTANT: including `identityAnchors` in the prompt/`productFacts` sent
 * to an `ImageGenerationProvider` (see build-input.ts) is NOT the same as
 * verifying the resulting image actually preserved them. Genuine
 * verification would require a vision-capable model comparing the
 * generated output against the source image's identity anchors
 * (material/color/shape/hardware/branding) — no such provider is
 * selected in this codebase (see services/generation/provider.server.ts;
 * only the deterministic test provider is wired, and it produces
 * placeholder pixels with no real relationship to the source image).
 *
 * So rather than pretend a check happened, this function returns an
 * honest, structured "not yet possible" result and records exactly which
 * anchors *would* need checking — visible in `GenerationResult.metadata.
 * identityValidation` today, so the merchant-facing data model already
 * has the right shape for a later phase to fill in a real check (call a
 * vision model, compare structurally, etc.) without a pipeline/schema
 * change. This is called for every generation result, not only
 * LIFESTYLE — identity preservation matters for every generationType.
 */
import type { IdentityAnchors } from "../intelligence/schema";

export interface IdentityValidationResult {
  validated: boolean;
  reason: string;
  /** The identity anchor field names this result *would* need checked
   * against, once a real check exists — derived from which anchors were
   * actually present on this product's Product Intelligence profile. */
  identityAnchorsChecked: string[];
}

function presentAnchorFields(identityAnchors: IdentityAnchors): string[] {
  const fields: string[] = ["category"]; // always required, never null
  if (identityAnchors.shape !== null) fields.push("shape");
  if (identityAnchors.material !== null) fields.push("material");
  if (identityAnchors.primaryColor !== null) fields.push("primaryColor");
  if (identityAnchors.constructionDetails.length > 0) fields.push("constructionDetails");
  if (identityAnchors.distinctiveHardware.length > 0) fields.push("distinctiveHardware");
  if (identityAnchors.brandingVisible) fields.push("brandingVisible", "brandingDescription");
  return fields;
}

/**
 * Records the (currently non-semantic) identity-validation outcome for
 * one generation result. Never throws — a missing/unconfigured
 * validation capability is an expected, honestly-reported state, not an
 * error that should fail the generation.
 */
export function recordIdentityValidation(identityAnchors: IdentityAnchors): IdentityValidationResult {
  return {
    validated: false,
    reason: "no vision-capable provider configured",
    identityAnchorsChecked: presentAnchorFields(identityAnchors),
  };
}
