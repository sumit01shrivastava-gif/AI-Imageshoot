/**
 * Pure mapping: a synced product + its Product Intelligence profile + a
 * validated `ParsedIntent` (+ creative context/reference images/brand
 * style) → a validated `GenerationPlan` with `generationType:
 * "CREATIVE_STUDIO"`. The Creative Studio's own counterpart to
 * services/generation/build-plan.ts's `buildGenerationPlan` — deliberately
 * a SEPARATE function, not a new branch inside that one: the input shape
 * is fundamentally different (a conversational instruction + resolved
 * session context, not "a generationType + optional preset"), but the
 * OUTPUT is the exact same `GenerationPlan` shape, going through the
 * exact same `GenerationJob`/queue/worker/storage pipeline every other
 * generationType already uses — see docs/creative-studio.md
 * "Architecture" for why this satisfies "use the existing GenerationPlan
 * architecture rather than creating a second unrelated generation
 * system."
 *
 * No I/O — everything it needs is passed in already loaded, mirroring
 * build-plan.ts's own shape.
 *
 * This is the ONE place a Creative Studio prompt is synthesized — always
 * from `ParsedIntent`'s structured fields + `IdentityConstraints`, NEVER
 * from the merchant's raw message text (see docs/creative-studio.md "No
 * arbitrary prompts", the same rule build-plan.ts already enforces for
 * every other generationType).
 */
import type { ProductDetail } from "../../db/repositories/shopify-product.repository";
import type { ProductIntelligenceRow } from "../../db/repositories/product-intelligence.repository";
import { IdentityAnchorsSchema } from "../intelligence/schema";
import { parseGenerationPlan, type GenerationPlan, type BrandStylePresetAttributes } from "../generation/schema";
import { toBrandStyleContext, buildProductFactsContext } from "../generation/build-plan";
import type { AspectRatioValue } from "../generation/types";
import type { ParsedIntent, CampaignCommunication } from "./intent-schema";
import type { CreativeIntentValue, GenerationModeValue } from "./types";
import { buildIdentityConstraints, buildStandaloneIdentityConstraints, filterProtectedRemovals } from "./identity-constraints";
import { buildCreativeBrief } from "./creative-brief";

export class ProductNotAnalyzedError extends Error {
  constructor() {
    super("This product must be analyzed (Product Intelligence) before using the Creative Studio.");
    this.name = "ProductNotAnalyzedError";
  }
}

export class MissingSourceImagesError extends Error {
  constructor() {
    super("This product has no image to start from.");
    this.name = "MissingSourceImagesError";
  }
}

const DEFAULT_ASPECT_RATIO: AspectRatioValue = "1:1";

const INTENT_FRAMING: Record<CreativeIntentValue, (subject: string) => string> = {
  CREATE_LIFESTYLE: (s) => `Lifestyle product photography featuring ${s}`,
  CREATE_MARKETPLACE: (s) => `Clean, evenly lit marketplace-style product photography of ${s} on a neutral background`,
  CREATE_SOCIAL: (s) => `Eye-catching, social-media-ready product photography of ${s}`,
  CREATE_BANNER: (s) => `Promotional banner photography featuring ${s}`,
  ADD_MODEL: (s) => `Photography featuring ${s} with a model interacting with it`,
  CHANGE_MODEL: (s) => `Photography featuring ${s} with a different model`,
  EDIT_BACKGROUND: (s) => `Photography of ${s} with an updated background`,
  CHANGE_SCENE: (s) => `Photography of ${s} in an updated scene`,
  CHANGE_LIGHTING: (s) => `Photography of ${s} with adjusted lighting`,
  CHANGE_CAMERA: (s) => `Photography of ${s} shot from an adjusted camera angle`,
  CHANGE_COMPOSITION: (s) => `Photography of ${s} with adjusted composition`,
  CHANGE_PROPS: (s) => `Photography of ${s} with updated styling props`,
  CHANGE_COLOR: (s) => `Photography of ${s} with an adjusted color palette`,
  REMOVE_ELEMENT: (s) => `Photography of ${s} with an element removed`,
  ADD_ELEMENT: (s) => `Photography of ${s} with an added element`,
  UPSCALE: (s) => `A higher-resolution, sharper rendition of the existing photography of ${s}`,
  VARIATION: (s) => `An alternative version of the existing composition featuring ${s}`,
  MULTI_VARIATION: (s) => `Alternative versions of the existing composition featuring ${s}`,
  REGENERATE: (s) => `A refreshed rendition of the existing composition featuring ${s}`,
};

/**
 * The explicit provider-prompt hierarchy (see docs/ai-pipeline.md
 * "Provider-input composition" for the full, documented reasoning):
 *
 *   1. Product identity / immutable characteristics — `identityInstruction`,
 *      stated FIRST, before any creative direction, so the constraint
 *      anchors the request rather than being an afterthought a model
 *      might weight less once a wall of scene/style description
 *      precedes it.
 *   2. Reference-image fidelity — an explicit "this is the exact image
 *      to edit forward from" clause, only for IMAGE_TO_IMAGE/IMAGE_EDIT/
 *      VARIATION (when `referenceNoun` is non-null).
 *   3. Product facts — added separately, upstream of this function, by
 *      services/ai/prompt-composition.ts's `composeProductGroundingPrefix`
 *      (title/description/category — what this product actually IS,
 *      voiced by the ai/ layer since `services/creative-studio/` doesn't
 *      own the final wire-level assembly).
 *   4. The user-requested creative transformation (intent framing +
 *      scene/style/add/remove/overrides).
 *   5–6. Composition/environment and lighting/camera/color direction
 *      (folded into the same clause list as 4 — they're all "what MAY
 *      change" and read naturally as one sentence, not artificially
 *      split into separate sentences).
 *   7. Output requirements — handled outside this function entirely, as
 *      real API parameters (`size`/`quality`/`n`), never restated as
 *      prose the model might contradict.
 */
function synthesizeCreativePrompt(
  intent: CreativeIntentValue,
  /** The FULLY-FORMED subject phrase — article/quantifier already
   * included, e.g. "the Handbags" (Shopify's category-based path) or "a
   * pair of sneakers" (a standalone session's own extracted subject —
   * see intent-schema.ts's `subject` doc comment). Each caller builds
   * this itself rather than this function prepending "the" uniformly,
   * since a real extracted subject already reads naturally on its own
   * and "the a pair of sneakers" would not. */
  subjectPhrase: string,
  creative: {
    action: string | null;
    scene: string | null;
    style: string[];
    lighting: string | null;
    composition: string | null;
    camera: string | null;
    colorDirection: string | null;
    depthOfField: string | null;
    addElements: string[];
    removeElements: string[];
    colorOverride: string | null;
    materialOverride: string | null;
  },
  identityInstruction: string,
  /** A short noun phrase for what's being edited forward from — e.g.
   * "the previous result" — when this turn is IMAGE_TO_IMAGE/IMAGE_EDIT/
   * VARIATION; `null` for a fresh TEXT_TO_IMAGE request (no reference
   * image exists yet, so there's nothing to state fidelity to). */
  referenceNoun: string | null,
  /**
   * The Creative Director's own coherent interpretation of this request
   * (creative-brief.ts's `CreativeBrief.overallCreativeDirection`) —
   * appended as a genuine, real-prose closing sentence, alongside (not
   * instead of) the atomic clause list below. Deliberately additive
   * rather than a replacement: the atomic clauses remain real,
   * machine-checkable structure a provider can't misparse, and this
   * codebase's existing regression coverage asserts against them
   * directly; the holistic sentence gives the same request genuine
   * creative-director framing too, which is what Part E actually asks
   * for — "a coherent creative-director interpretation, not merely a
   * concatenation of atomic fields" is satisfied by this sentence
   * existing as a real, tested, inspectable artifact
   * (`CreativeBrief.overallCreativeDirection`), not by deleting the
   * atomic fields that already work.
   */
  overallCreativeDirection: string,
  /**
   * The Creative Director's own unifying visual idea for this shot
   * (`CreativeBrief.creativeConcept`) — `null` on the deterministic
   * fallback path and whenever a real provider judged the request too
   * thin to warrant one (see intent-schema.ts's `creativeConcept` doc
   * comment). When present, stated as its own concept-first clause
   * immediately after identity/reference-fidelity and before the atomic
   * clause list, so the synthesized prompt reads "here is the idea,
   * here are the decisions that serve it" rather than one more
   * attribute appended to the end — additive only, never replaces
   * `overallCreativeDirection`'s existing closing-sentence role.
   */
  creativeConcept: string | null,
  /** Broad campaign work uses the reference only for product truth, not
   * as the creative composition/default environment. */
  campaignSceneTransformation: boolean,
  campaignCommunication: CampaignCommunication,
  /** Compact, structured execution priorities. This remains separate
   * from the holistic direction so a real vendor's prose cannot
   * accidentally omit its own operational decisions before the final
   * provider prompt is assembled. */
  inferredCreativeDecisions: string[],
): string {
  const subject = subjectPhrase;
  const parts = [INTENT_FRAMING[intent](subject)];

  // Stated early, right after the subject itself — a requested pose/
  // activity is a property of the SUBJECT, not the surrounding scene
  // (see intent-schema.ts's `action` doc comment for why this exists:
  // without it, a requested pose change had nowhere structured to go
  // and was silently dropped, leaving the model's own "preserve exactly
  // as shown" reference-image instruction uncontested for pose too).
  if (creative.action) parts.push(`performing ${creative.action}`);
  if (creative.scene) parts.push(`placed in ${creative.scene}`);
  if (creative.style.length > 0) parts.push(`${creative.style.join(", ")} style`);
  if (creative.lighting) parts.push(creative.lighting);
  if (creative.composition) parts.push(`${creative.composition} composition`);
  if (creative.camera) parts.push(`${creative.camera} camera angle`);
  if (creative.colorDirection) parts.push(`${creative.colorDirection} color palette`);
  if (creative.depthOfField) parts.push(creative.depthOfField);
  if (creative.addElements.length > 0) parts.push(`with ${creative.addElements.join(", ")}`);
  if (creative.removeElements.length > 0) parts.push(`without ${creative.removeElements.join(", ")}`);
  // The creative-override mechanism's effect on the prompt text itself
  // (identityInstruction carries the corresponding "this is permitted"
  // clause — see identity-constraints.ts). `subject` is already the
  // FULLY-FORMED phrase (see this function's `subjectPhrase` parameter
  // doc comment) — no separate "the" prefix here, or a real extracted
  // subject like "a pair of sneakers" would read "the a pair of
  // sneakers recolored...".
  if (creative.colorOverride) parts.push(`${subject} recolored to ${creative.colorOverride}`);
  if (creative.materialOverride) parts.push(`${subject} rendered in ${creative.materialOverride}`);

  const referenceFidelity = referenceNoun
    ? campaignSceneTransformation
      ? ` Use ${referenceNoun} as the exact physical-product source of truth; preserve the product, but do not preserve its source scene, presentation, composition, lighting, props, or atmosphere.`
      : ` Use ${referenceNoun} as the exact starting point for this edit — preserve everything about its current rendering except what is explicitly requested below.`
    : "";

  // Concept-first: stated before the atomic clause list so the concept
  // reads as the idea the following decisions serve, not as one more
  // item appended after them. Omitted entirely when there is no concept
  // (the common case on the deterministic path) — never an empty/filler
  // sentence.
  const conceptClause = creativeConcept ? ` SELECTED CAMPAIGN PROPOSITION: ${creativeConcept}.` : "";
  const campaignClause = campaignSceneTransformation
    ? " Campaign scene transformation is required: use the reference only for the physical product; actively discard incidental source-scene influence and create a new, product-derived commercial world rather than an enhanced version of the source photograph."
    : "";
  const executionClause =
    inferredCreativeDecisions.length > 0 ? ` Execution priorities: ${inferredCreativeDecisions.slice(0, 3).join(" ")}` : "";
  const communicationClause =
    campaignCommunication.mode === "VISUAL_ONLY"
      ? " Keep the result visual-first: do not add campaign copy, invented branding, logos, labels, slogans, or decorative typography."
      : campaignCommunication.mode === "MINIMAL_CAMPAIGN_COPY"
        ? ` CAMPAIGN COMMUNICATION: reserve ${campaignCommunication.reservedTextArea.toLowerCase().replace(/_/g, " ")} as clean, legible negative space and include only this minimal approved copy: headline “${campaignCommunication.headline ?? ""}”${campaignCommunication.supportingLine ? `; supporting line “${campaignCommunication.supportingLine}”` : ""}. Do not add any other text, brand, logo, claim, or badge.`
        : ` FACTUAL CAMPAIGN COMMUNICATION: reserve ${campaignCommunication.reservedTextArea.toLowerCase().replace(/_/g, " ")} as clean, legible negative space and include only the approved merchant-supplied copy: ${[campaignCommunication.headline, campaignCommunication.supportingLine, ...campaignCommunication.callouts].filter(Boolean).map((copy) => `“${copy}”`).join("; ")}. Do not add, rewrite, or elaborate factual claims, brands, logos, labels, or badges.`;

  return `${identityInstruction}${referenceFidelity}${conceptClause}${campaignClause} ${parts.join(", ")}. ${overallCreativeDirection}${executionClause}${communicationClause}`;
}

export interface BuildCreativeGenerationPlanInput {
  product: ProductDetail;
  intelligence: ProductIntelligenceRow | null;
  /** The ORIGINAL Shopify-hosted product image(s) — always included for
   * identity grounding, regardless of generation mode (even an
   * IMAGE_TO_IMAGE follow-up should still ground against the true
   * original, not just the intermediate result — see
   * docs/creative-studio.md "Identity preservation"). */
  sourceMediaIds: string[];
  parsedIntent: ParsedIntent;
  /** The specific prior result being edited forward from — only present
   * for IMAGE_TO_IMAGE/IMAGE_EDIT/VARIATION modes; `null` for the
   * session's first (TEXT_TO_IMAGE) message. */
  previousResultUrl: string | null;
  brandStylePreset?: BrandStylePresetAttributes | null;
  creativeSessionId: string;
  /** The merchant's own raw message — recorded on the plan for
   * traceability ONLY (see module doc comment); never used to build
   * `creativeDirection.prompt`. */
  rawInstruction: string;
  aspectRatioOverride?: AspectRatioValue;
  /** Which of `parsedIntent`'s style/lighting/composition/camera/
   * colorDirection were filled in by this user's own learned preference
   * (session.server.ts's `applyLearnedDefaults`) rather than specified
   * by THIS message — threaded straight through to
   * `creative-brief.ts`'s `buildCreativeBrief` so the persisted plan can
   * tell the two apart. See that file's "Explicit vs. personalized vs.
   * inferred" doc comment. `[]`/omitted for a Shopify call (no `userId`
   * concept — see personalization.server.ts) or when nothing was
   * personalized this turn. */
  personalizedFields?: readonly string[];
}

/**
 * Builds and validates a `GenerationPlan` for one Creative Studio
 * request. Throws `MissingSourceImagesError`/`ProductNotAnalyzedError` —
 * same preconditions services/generation/build-plan.ts's
 * `buildGenerationPlan` already enforces for every other generationType,
 * for the identical reason (generation without identity anchors would
 * defeat the entire point of this feature).
 */
export function buildCreativeGenerationPlan(input: BuildCreativeGenerationPlanInput): GenerationPlan {
  const {
    product,
    intelligence,
    sourceMediaIds,
    parsedIntent,
    previousResultUrl,
    brandStylePreset,
    creativeSessionId,
    rawInstruction,
    personalizedFields,
  } = input;

  const requestedIds = new Set(sourceMediaIds.length > 0 ? sourceMediaIds : product.media.map((m) => m.id));
  const sourceImages = product.media
    .filter((media) => requestedIds.has(media.id))
    .map((media) => ({
      mediaId: media.id,
      url: media.originalUrl,
      altText: media.altText,
      position: media.position,
    }));

  if (sourceImages.length === 0) {
    throw new MissingSourceImagesError();
  }

  if (!intelligence || intelligence.status !== "READY") {
    throw new ProductNotAnalyzedError();
  }

  const identityAnchorsResult = IdentityAnchorsSchema.safeParse(intelligence.identityAnchors);
  if (!identityAnchorsResult.success) {
    throw new ProductNotAnalyzedError();
  }
  const identityAnchors = identityAnchorsResult.data;

  const category = intelligence.category ?? (product.productType || "product");
  const identityConstraints = buildIdentityConstraints(identityAnchors, product.title, parsedIntent.attributeOverrides);

  // "Remove the logo" (Part 4 worked example): a requested removal that
  // names a protected brand/identity element must never reach the
  // prompt — it would directly contradict the identity instruction's
  // own "do not alter any visible logos" clause two sentences earlier.
  // Filtered BEFORE building `creative` so both the synthesized prompt
  // and the persisted `creativeIntent.creative.removeElements` agree on
  // what was actually requested of the provider; `blocked` is kept
  // separately for traceability (see identity-constraints.ts's doc
  // comment) rather than silently dropped.
  const { allowed: removeElements, blocked: blockedRemovals } = filterProtectedRemovals(parsedIntent.removeElements);

  const creative = {
    action: parsedIntent.action,
    scene: parsedIntent.scene,
    style: parsedIntent.style,
    lighting: parsedIntent.lighting,
    composition: parsedIntent.composition,
    camera: parsedIntent.camera,
    colorDirection: parsedIntent.colorDirection,
    depthOfField: parsedIntent.depthOfField,
    addElements: parsedIntent.addElements,
    removeElements,
    blockedRemovals,
    colorOverride: parsedIntent.attributeOverrides.color,
    materialOverride: parsedIntent.attributeOverrides.material,
  };

  const isEditTurn =
    Boolean(previousResultUrl) && (parsedIntent.mode === "IMAGE_TO_IMAGE" || parsedIntent.mode === "IMAGE_EDIT" || parsedIntent.mode === "VARIATION");

  const creativeBrief = buildCreativeBrief({
    intent: parsedIntent.intent,
    subjectPhrase: `the ${category}`,
    action: creative.action,
    scene: creative.scene,
    style: creative.style,
    lighting: creative.lighting,
    composition: creative.composition,
    camera: creative.camera,
    colorDirection: creative.colorDirection,
    depthOfField: creative.depthOfField,
    addElements: creative.addElements,
    removeElements: creative.removeElements,
    colorOverride: creative.colorOverride,
    materialOverride: creative.materialOverride,
    isEditTurn,
    preservationRequirements: identityConstraints.immutable,
    personalizedFields,
    externalCreativeDirection: parsedIntent.overallCreativeDirection,
    externalInferredCreativeDecisions: parsedIntent.inferredCreativeDecisions,
    externalCreativeConcept: parsedIntent.creativeConcept,
    externalNegativeCreativeDecisions: parsedIntent.negativeCreativeDecisions,
    externalCampaignCommunication: parsedIntent.campaignCommunication,
    trustedCampaignFacts: [product.title, product.description ?? ""],
    category,
  });

  const prompt = synthesizeCreativePrompt(
    parsedIntent.intent,
    `the ${category}`,
    creative,
    identityConstraints.instruction,
    isEditTurn ? "the reference image provided" : null,
    creativeBrief.overallCreativeDirection,
    creativeBrief.creativeConcept,
    creativeBrief.campaignSceneTransformation,
    creativeBrief.campaignCommunication,
    creativeBrief.inferredCreativeDecisions,
  );

  const referenceImages = isEditTurn ? [{ url: previousResultUrl!, role: "previous_result" as const }] : [];

  const plan = {
    generationType: "CREATIVE_STUDIO" as const,
    assetType: intelligence.recommendedAssetTypes[0] ?? null,
    category,

    sourceProductId: product.id,
    sourceImages,

    productFacts: {
      identityAnchors,
      ...buildProductFactsContext(product),
    },

    creativeDirection: {
      prompt,
      negativeConstraints: creativeBrief.negativeCreativeDecisions,
      environment: creative.scene,
      lighting: creative.lighting,
      composition: creative.composition,
    },

    aspectRatio: input.aspectRatioOverride ?? DEFAULT_ASPECT_RATIO,
    outputFormat: "png",
    quality: "standard",
    outputCount: parsedIntent.variationCount,

    modelConfiguration:
      intelligence.modelSuitable === null
        ? null
        : {
            modelSuitable: intelligence.modelSuitable,
            recommendedModelAttributes: intelligence.recommendedModelAttributes as Record<string, unknown> | null,
            recommendedPoseTypes: intelligence.recommendedPoseTypes,
          },

    brandStyle: brandStylePreset ? toBrandStyleContext(brandStylePreset) : null,
    lifestyleScene: null,

    creativeIntent: {
      intent: parsedIntent.intent,
      mode: parsedIntent.mode as GenerationModeValue,
      creative,
      identityConstraints,
      creativeBrief,
      creativeSessionId,
      rawInstruction,
    },
    referenceImages,

    constraints: [],
  };

  return parseGenerationPlan(plan);
}

export interface BuildStandaloneCreativeGenerationPlanInput {
  parsedIntent: ParsedIntent;
  /** Signed URLs of any images the merchant attached to THIS turn,
   * already durably stored via reference-images.server.ts's
   * `uploadReferenceImages` — never raw bytes at this layer. Empty for a
   * from-scratch text-to-image request with nothing to ground against. */
  uploadedReferenceImageUrls: string[];
  /** The prior result (or the session's own "Continue editing" starting
   * image) this turn edits forward from, if any — the exact same
   * resolution session.server.ts performs for the Shopify path,
   * `resolveSessionStartingImage`/`editSourceResult`. */
  previousResultUrl: string | null;
  creativeSessionId: string;
  /** The merchant's own raw message — recorded on the plan for
   * traceability ONLY, same rule as `BuildCreativeGenerationPlanInput`. */
  rawInstruction: string;
  aspectRatioOverride?: AspectRatioValue;
  /** This session's own subject from an earlier turn — e.g. "a pair of
   * sneakers" — read from `CreativeContext.activeSubject`. Used only
   * when THIS turn's own `parsedIntent.subject` is null (a follow-up
   * that doesn't restate the subject, e.g. "make it brighter") so the
   * prompt still names the real subject instead of collapsing to the
   * generic "product" fallback. `null`/omitted for the session's first
   * turn, where there is nothing yet to carry forward. */
  activeSubject?: string | null;
  /** This session's own pose/activity from an earlier turn — e.g.
   * "yoga" — same carry-forward reasoning as `activeSubject`, read from
   * `CreativeContext.activeAction`. See intent-schema.ts's `action` doc
   * comment. */
  activeAction?: string | null;
  /** Which of `parsedIntent`'s style/lighting/composition/camera/
   * colorDirection were filled in by this user's own learned preference
   * rather than specified by THIS message — see
   * `BuildCreativeGenerationPlanInput.personalizedFields`'s identical
   * doc comment. */
  personalizedFields?: readonly string[];
}

/**
 * The standalone (no Shopify product) counterpart to
 * `buildCreativeGenerationPlan` above — produces the EXACT SAME
 * `GenerationPlan` shape, validated the same way, flowing through the
 * exact same `GenerationJob`/queue/worker/storage pipeline every other
 * generationType already uses (see module doc comment) — just grounded in
 * whatever the merchant uploaded/instructed THIS conversation rather than
 * a Shopify product + Product Intelligence profile. Never fabricates
 * product metadata:
 *
 *   - `productFacts` stays entirely null — there is no catalog fact to
 *     report (see services/generation/schema.ts's `productFacts` doc
 *     comment: "mandatory whenever Product Intelligence has run... null
 *     only when it hasn't").
 *   - `sourceProductId`/`sourceImages` stay null/empty — there is no
 *     `ShopifyProduct`/`ShopifyProductMedia` to reference at all; any
 *     uploaded/prior-result image lives in `referenceImages` instead
 *     (mirroring how the Shopify path already treats a conversational
 *     follow-up's prior result — see `referenceImages` above).
 *   - `category`/the prompt's subject uses the merchant's own extracted
 *     `subject` when the intent parser found one (or the session's own
 *     `activeSubject` carried forward from an earlier turn — see
 *     `BuildStandaloneCreativeGenerationPlanInput.activeSubject`) —
 *     e.g. "a pair of sneakers," never the merchant's raw message text
 *     verbatim (still governed by the exact same "structured fields →
 *     synthesized prompt" rule as everything else in this file). Only
 *     when NEITHER exists does this fall back to the same plain
 *     "product" placeholder services/generation/build-plan.ts's Shopify
 *     path already falls back to when a real product has no
 *     `productType` either — a grammatical placeholder, never a
 *     guessed/invented category. See intent-schema.ts's `subject` doc
 *     comment and docs/creative-studio.md "Standalone subject
 *     extraction".
 *   - `identityConstraints.immutable` stays empty — nothing was ever
 *     analyzed to assert as immutable (see identity-constraints.ts's
 *     `buildStandaloneIdentityConstraints`); reference-image fidelity
 *     (when an image exists to ground against) is still asserted
 *     structurally, mirroring the Shopify path's own reference-fidelity
 *     clause.
 */
export function buildStandaloneCreativeGenerationPlan(input: BuildStandaloneCreativeGenerationPlanInput): GenerationPlan {
  const { parsedIntent, uploadedReferenceImageUrls, previousResultUrl, creativeSessionId, rawInstruction, personalizedFields } = input;

  // This turn's own extracted subject wins; a follow-up that doesn't
  // restate one ("make it brighter") falls back to whatever this
  // session already established. Only when NEITHER exists — the
  // session's very first turn, and the parser found nothing usable in
  // it — does this collapse to the generic "product" placeholder. This
  // is the actual fix for the real production bug this pass addresses:
  // previously `category` was unconditionally "product" here, so every
  // standalone request's prompt subject was always "the product,"
  // regardless of what the merchant described (see
  // docs/creative-studio.md "Standalone subject extraction").
  const resolvedSubject = parsedIntent.subject ?? input.activeSubject ?? null;
  const category = resolvedSubject ?? "product";
  const hasReferenceImage = uploadedReferenceImageUrls.length > 0 || Boolean(previousResultUrl);
  const identityConstraints = buildStandaloneIdentityConstraints(hasReferenceImage, parsedIntent.attributeOverrides);

  // Same protected-removal rule as the Shopify path (Part 4 worked
  // example) — a standalone photo can still depict a real branded
  // product the merchant owns; "remove the logo" must be declined here
  // too, not just when Product Intelligence happens to be involved.
  const { allowed: removeElements, blocked: blockedRemovals } = filterProtectedRemovals(parsedIntent.removeElements);

  const creative = {
    // Persisted so a LATER turn's `CreativeContext.activeSubject` (see
    // creative-context.ts) can read it back — `resolvedSubject`, not
    // `category`, so a session that never had a real subject correctly
    // keeps carrying forward `null` (never "product" as if it were a
    // genuinely known subject).
    subject: resolvedSubject,
    // Same carry-forward reasoning as `subject` immediately above — see
    // intent-schema.ts's `action` doc comment and
    // creative-context.ts's `activeAction`.
    action: parsedIntent.action ?? input.activeAction ?? null,
    scene: parsedIntent.scene,
    style: parsedIntent.style,
    lighting: parsedIntent.lighting,
    composition: parsedIntent.composition,
    camera: parsedIntent.camera,
    colorDirection: parsedIntent.colorDirection,
    depthOfField: parsedIntent.depthOfField,
    addElements: parsedIntent.addElements,
    removeElements,
    blockedRemovals,
    colorOverride: parsedIntent.attributeOverrides.color,
    materialOverride: parsedIntent.attributeOverrides.material,
  };

  const isEditTurn =
    hasReferenceImage &&
    (parsedIntent.mode === "IMAGE_TO_IMAGE" || parsedIntent.mode === "IMAGE_EDIT" || parsedIntent.mode === "VARIATION");

  const referenceNoun = previousResultUrl
    ? "the reference image provided"
    : uploadedReferenceImageUrls.length > 0
      ? "the uploaded reference image"
      : null;

  // A real extracted/carried-forward subject already reads naturally on
  // its own ("a pair of sneakers") — only the generic "product"
  // fallback needs the "the" article prepended (preserves the exact
  // prior wording, "the product," for a turn where no subject was ever
  // established).
  const subjectPhrase = resolvedSubject ?? `the ${category}`;

  const creativeBrief = buildCreativeBrief({
    intent: parsedIntent.intent,
    subjectPhrase,
    action: creative.action,
    scene: creative.scene,
    style: creative.style,
    lighting: creative.lighting,
    composition: creative.composition,
    camera: creative.camera,
    colorDirection: creative.colorDirection,
    depthOfField: creative.depthOfField,
    addElements: creative.addElements,
    removeElements: creative.removeElements,
    colorOverride: creative.colorOverride,
    materialOverride: creative.materialOverride,
    isEditTurn,
    // A standalone session has no analyzed IdentityAnchors to derive a
    // real preservation list from (buildStandaloneIdentityConstraints's
    // `immutable` stays permanently empty — see that function's doc
    // comment); reference-image fidelity is still asserted structurally
    // by composeOverallCreativeDirection's `isEditTurn` branch.
    preservationRequirements: [],
    personalizedFields,
    externalCreativeDirection: parsedIntent.overallCreativeDirection,
    externalInferredCreativeDecisions: parsedIntent.inferredCreativeDecisions,
    externalCreativeConcept: parsedIntent.creativeConcept,
    externalNegativeCreativeDecisions: parsedIntent.negativeCreativeDecisions,
    externalCampaignCommunication: parsedIntent.campaignCommunication,
    // A standalone session's "category" is whatever real subject was
    // resolved (see `resolvedSubject` above) — `null` only when neither
    // this turn nor the session ever established one, which correctly
    // falls back to `resolveProductInteraction`'s generic default rather
    // than guessing.
    category: resolvedSubject,
  });

  const prompt = synthesizeCreativePrompt(
    parsedIntent.intent,
    subjectPhrase,
    creative,
    identityConstraints.instruction,
    isEditTurn ? referenceNoun : null,
    creativeBrief.overallCreativeDirection,
    creativeBrief.creativeConcept,
    creativeBrief.campaignSceneTransformation,
    creativeBrief.campaignCommunication,
    creativeBrief.inferredCreativeDecisions,
  );

  // Ground-truth reference for the actual PROVIDER call —
  // services/ai/openai-image-provider.server.ts's `resolveReferenceImageUrls`
  // prefers `referenceImages` over `sourceImages`, so an empty
  // `sourceImages` above is never a problem: every reference this plan
  // has lives here. `previousResultUrl` (this session's own prior
  // result) is listed last so it stays the primary "edit forward from"
  // reference when both a fresh upload and a prior result exist in the
  // same turn — mirrors the Shopify path's own ordering intent (the most
  // recently produced image is what "editing forward" means).
  const referenceImages: GenerationPlan["referenceImages"] = [
    ...uploadedReferenceImageUrls.map((url) => ({ url, role: "product_original" as const })),
    ...(previousResultUrl ? [{ url: previousResultUrl, role: "previous_result" as const }] : []),
  ];

  const plan = {
    generationType: "CREATIVE_STUDIO" as const,
    assetType: null,
    category,

    sourceProductId: null,
    sourceImages: [],

    productFacts: {
      identityAnchors: null,
      title: null,
      description: null,
      attributes: null,
    },

    creativeDirection: {
      prompt,
      negativeConstraints: creativeBrief.negativeCreativeDecisions,
      environment: creative.scene,
      lighting: creative.lighting,
      composition: creative.composition,
    },

    aspectRatio: input.aspectRatioOverride ?? DEFAULT_ASPECT_RATIO,
    outputFormat: "png",
    quality: "standard",
    outputCount: parsedIntent.variationCount,

    modelConfiguration: null,

    brandStyle: null,
    lifestyleScene: null,

    creativeIntent: {
      intent: parsedIntent.intent,
      mode: parsedIntent.mode as GenerationModeValue,
      creative,
      identityConstraints,
      creativeBrief,
      creativeSessionId,
      rawInstruction,
    },
    referenceImages,

    constraints: [],
  };

  return parseGenerationPlan(plan);
}
