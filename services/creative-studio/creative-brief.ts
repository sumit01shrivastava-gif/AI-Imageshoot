/**
 * The Creative Director reasoning stage (Part B of the "creative
 * intelligence" specification this file implements).
 *
 * Deliberately a SEPARATE, intermediate structure — not collapsed into
 * `ParsedIntent` (intent-schema.ts). `ParsedIntent` is the parser's
 * atomic, field-by-field reading of one message ("scene: temple",
 * "lighting: cinematic"); a `CreativeBrief` is the layer ABOVE that: a
 * holistic interpretation of what the finished image should actually
 * look like, grounded in those same fields but expressed as a coherent
 * creative decision rather than a bag of independent knobs. This is the
 * genuine intermediate object the spec asks for — the pipeline is:
 *
 *   ParsedIntent (+ identity constraints, + reference-image context)
 *     -> buildCreativeBrief (this file)
 *     -> CreativeBrief { ...structured fields, overallCreativeDirection }
 *     -> plan-builder.ts folds it into the synthesized prompt AND
 *        persists it on GenerationPlan.creativeIntent.creativeBrief
 *
 * Deliberately compact, not "an enormous rigid schema": every field
 * ParsedIntent/CreativeStudioPlanSchema's existing `creative` sub-object
 * already carries verbatim (scene/style/lighting/composition/camera/
 * colorDirection/addElements/removeElements) is NOT duplicated here under
 * a second name — this object only adds the genuinely NEW information a
 * creative-director reasoning pass contributes: an explicit objective,
 * how the subject itself should read, what must never change, what MUST
 * change (grouped, not scattered), what must visibly appear in the
 * frame, and one real, coherent prose sentence tying all of it together.
 *
 * `overallCreativeDirection` is real and populated for EVERY request
 * today via `composeOverallCreativeDirection` below — a deterministic,
 * rule-based synthesis in the same spirit as
 * services/ai/heuristic-intent-parser.ts's "a real, always-on default,
 * not a stub" — genuine prose with real connectives ("while", "so that"),
 * not a comma-joined field dump. When a real, multimodal-capable
 * `IntentParsingProvider` is configured and its own raw output supplies
 * one (`ParsedIntentRawOutput.overallCreativeDirection` —
 * services/ai/types.ts), that vendor-authored sentence is used INSTEAD,
 * since a real model reasoning over the actual reference-image pixels
 * can produce a genuinely richer interpretation than a deterministic
 * template ever could. Either way, `CreativeBrief.overallCreativeDirection`
 * is never null/empty for a built plan.
 *
 * ## Explicit vs. personalized vs. inferred — three kinds of creative decision
 *
 * `transformationRequirements` is exclusively WHAT THE USER EXPLICITLY
 * REQUESTED THIS TURN — every entry traces back to a non-null field the
 * intent parser actually extracted from THIS message (or a creative
 * override). `action`/`scene`/`addElements`/`removeElements`/the
 * attribute overrides can only ever land here — personalization never
 * touches request-specific CONTENT (see
 * personalization.server.ts's own doc comment on why `LEARNABLE_FIELDS`
 * excludes them).
 *
 * `personalizationApplied` is the separate, previously-conflated case:
 * one of the 5 fields personalization CAN fill (`style`/`lighting`/
 * `composition`/`camera`/`colorDirection`) that this turn's own message
 * left unspecified, filled in from this user's own learned preference by
 * `services/creative-studio/personalization.server.ts`'s
 * `applyLearnedDefaults` — BEFORE the intent this file receives (a real,
 * previously-undetected imprecision: prior to this field existing, a
 * personalization-filled value was indistinguishable from something the
 * merchant actually typed once it reached this layer, contradicting this
 * module's own "explicit vs. inferred" framing). Callers pass
 * `personalizedFields` (the caller already knows, from comparing the
 * pre- and post-`applyLearnedDefaults` intent, which fields changed) —
 * this file never re-derives it and never talks to the profile store
 * directly, keeping the "creative-studio orchestrates, personalization
 * is a narrow service" boundary intact.
 *
 * `inferredCreativeDecisions` is the separate, genuinely new
 * concept this section adds: WHAT A PROFESSIONAL CREATIVE DIRECTOR
 * SHOULD DO TO EXECUTE THAT REQUEST WELL, even though the merchant never
 * said it in those words — e.g. a requested pose change implies
 * "anatomically plausible body mechanics," a requested night scene
 * implies "light the subject to plausibly match a nighttime environment
 * rather than pasting a dark background behind daylight lighting." These
 * are never invented independently of what was explicitly requested —
 * each one is conditioned on an explicit field already being present
 * (see `inferCreativeDecisions`'s own per-rule comments) — and never
 * contradicts it, only strengthens its execution. `inferCreativeDecisions`
 * is a small, deterministic, always-on default (same "real non-AI
 * default" philosophy as the rest of this file); when a real,
 * multimodal-capable `IntentParsingProvider` supplies its OWN inferred
 * decisions, those are used instead (see
 * `externalInferredCreativeDecisions`) — a real creative-director model
 * reasoning over the actual reference image can make far more specific,
 * contextual calls (e.g. genuinely deciding what "premium" implies for
 * THIS product) than a fixed rule table ever could; the deterministic
 * rules below exist so the system is never creatively inert while no
 * live vendor is configured.
 *
 * ## `creativeConcept` and `negativeCreativeDecisions` (Phase 1 of the
 * internal-creative-reasoning upgrade)
 *
 * Two more fields, both following the exact same "LLM supplies a real
 * one, deterministic path supplies an honest fallback" pattern as
 * `overallCreativeDirection`/`inferredCreativeDecisions` above, but with
 * one deliberate asymmetry: `creativeConcept` (the single unifying
 * visual idea — see `CreativeBrief.creativeConcept`'s own doc comment)
 * has NO deterministic fallback and stays `null` on the deterministic
 * path always. Genuine concept development ("an oversized sculptural
 * environment that turns the product into a monumental object") is
 * exactly the kind of reasoning a fixed rule table cannot fake without
 * becoming either a giant keyword-to-cliché lookup (fake intelligence)
 * or a generic restatement of the objective (not actually a concept) —
 * so this module honestly leaves it to the real LLM path rather than
 * pretending a template can do it.
 *
 * `negativeCreativeDecisions` (deliberate restraint — what to leave
 * OUT) gets a real, minimal deterministic default: exactly one rule,
 * `inferNegativeCreativeDecisions` below, paired 1:1 with the existing
 * subject-dominance rule in `inferCreativeDecisions` (asserting a
 * subject should be dominant and asserting nothing should be allowed to
 * compete with it are two halves of the same decision). Feeds the
 * plan's `creativeDirection.negativeConstraints` — see plan-builder.ts —
 * which was always empty for Creative Studio before this. Deliberately
 * NOT the same list as `removeElements`: that field is exclusively what
 * the MERCHANT explicitly asked to remove; this one is the Creative
 * Director's own judgment about what to exclude, and the two are never
 * merged.
 */
import type { CreativeIntentValue } from "./types";
import { resolveProductInteraction } from "../generation/product-interaction";

/** Style/lighting keywords that indicate a moody/dramatic treatment was
 * asked for — used only to decide whether to add a shadow-control
 * inference, never to invent a mood that wasn't requested. */
const MOODY_PATTERN = /\b(dark|moody|dramatic|cinematic|noir|night)\b/i;
const PREMIUM_PATTERN = /\b(premium|luxury|luxurious|high[- ]end|upscale)\b/i;
const NIGHT_PATTERN = /\bnight\b/i;
const SHALLOW_DEPTH_PATTERN = /\b(shallow|blurred|bokeh)\b/i;
const MATERIAL_CATEGORY_PATTERNS: ReadonlyArray<{ pattern: RegExp; decision: string }> = [
  {
    pattern: /\b(jewelry|jewellery|watch|metal)\b/i,
    decision: "Use controlled specular highlights and precise edge definition so metal, stones, and fine detail remain readable rather than glittering into indistinct glare.",
  },
  {
    pattern: /\b(glass|bottle|fragrance|perfume)\b/i,
    decision: "Render glass with believable reflection, refraction, and transparent depth; retain the product silhouette and label/detail readability rather than making it look plastic.",
  },
  {
    pattern: /\b(cosmetics?|beauty|skincare|makeup)\b/i,
    decision: "Use clean, controlled light that keeps packaging, finish, and product details readable without invented copy or distracting beauty props.",
  },
  {
    pattern: /\b(clothing|apparel|fashion|fabric|textile)\b/i,
    decision: "Light fabric to reveal believable weave, drape, seams, and volume without flattening its texture or distorting its fit.",
  },
  {
    pattern: /\b(electronic|device|phone|laptop|computer|headphone)\b/i,
    decision: "Use controlled reflections and clean edge separation so the device reads as a precise, real object rather than a glossy synthetic render.",
  },
  {
    pattern: /\b(food|beverage|drink|coffee|tea|snack)\b/i,
    decision: "Preserve believable food texture, moisture, temperature cues, and scale; lighting should make the product appetizing without artificial gloss.",
  },
];
/** Intents that describe a FRESH, from-scratch creative image (as
 * opposed to editing/varying an existing one) where subject-vs-background
 * visual hierarchy is always a relevant creative concern. */
const FRESH_CREATIVE_INTENTS: ReadonlySet<CreativeIntentValue> = new Set([
  "CREATE_LIFESTYLE",
  "CREATE_MARKETPLACE",
  "CREATE_SOCIAL",
  "CREATE_BANNER",
  "ADD_MODEL",
]);

export interface CreativeBrief {
  /** One sentence naming what this generation is FOR — e.g. "Produce an
   * aspirational lifestyle photograph that makes the product feel
   * desirable in a real, lived-in context." Derived from `intent`, not
   * merchant-typed. */
  creativeObjective: string;
  /** How the subject itself should read in the result — e.g. "natural
   * and candid, not stiffly posed" when an action/pose change was
   * requested; `null` when nothing about subject treatment was
   * specified this turn. */
  subjectTreatment: string | null;
  /** What must NOT change — human-readable identity anchors (mirrors
   * `IdentityConstraints.immutable` verbatim; kept here too so a
   * `CreativeBrief` is a genuinely self-contained artifact a test or a
   * future reasoning stage can inspect without reaching into a sibling
   * object). Empty for a standalone session with nothing yet analyzed. */
  preservationRequirements: string[];
  /** What THIS turn's OWN message is actually asking to change, grouped
   * as "dimension: value" entries — e.g. "pose/action: yoga",
   * "environment: a dark, atmospheric temple", "lighting: cinematic,
   * moody". This is the direct, assertable evidence a regression test
   * checks for the exact failure class Part P/Q describe: a request
   * naming a pose/environment/lighting change must show up here, not
   * just somewhere inside a prose paragraph. Never includes a value that
   * came from personalization — see `personalizationApplied`. */
  transformationRequirements: string[];
  /** One of the 5 personalizable dimensions (style/lighting/composition/
   * camera/colorDirection — see personalization.server.ts's
   * `LEARNABLE_FIELDS`) that THIS message left unspecified and this
   * user's own learned preference filled in instead — see module doc
   * comment's "Explicit vs. personalized vs. inferred". Empty for a
   * Shopify call (no `userId` concept), for a user with no learned
   * preference yet, or when the message specified every dimension
   * itself. Never contains a value the message itself specified. */
  personalizationApplied: string[];
  /** Short noun phrases that must visibly appear in the frame — added
   * elements plus the named scene/action, when present. */
  importantElements: string[];
  /** WHAT A PROFESSIONAL CREATIVE DIRECTOR SHOULD INFER IS NECESSARY TO
   * EXECUTE THE EXPLICIT REQUEST WELL — see module doc comment's
   * "Explicit vs. inferred". Always empty-or-conditioned-on an explicit
   * field already present; never contradicts `transformationRequirements`
   * or `preservationRequirements`. */
  inferredCreativeDecisions: string[];
  /** ONE unifying visual idea for this shot — what makes it distinctive
   * rather than generic — never an adjective list. `null` on the
   * deterministic path always (see module doc comment) and whenever a
   * real LLM judged the request too narrow for a real concept to add
   * anything. Never contradicts an explicit field (`scene`/`lighting`/
   * `composition`/...) — only fills what those left unspecified. */
  creativeConcept: string | null;
  /** Deliberate restraint — specific things the Creative Director
   * decided should be EXCLUDED because they would weaken the concept
   * (e.g. "generic studio backdrop"). Never the same list as
   * `removeElements` (see `transformationRequirements`), which is
   * exclusively what the merchant explicitly asked to remove. Feeds
   * `GenerationPlan.creativeDirection.negativeConstraints` — see
   * plan-builder.ts. */
  negativeCreativeDecisions: string[];
  /** The one coherent, holistic sentence — see module doc comment. */
  overallCreativeDirection: string;
}

const INTENT_OBJECTIVE: Record<CreativeIntentValue, string> = {
  CREATE_LIFESTYLE: "Produce an aspirational lifestyle photograph that makes the product feel desirable in a real, lived-in context.",
  CREATE_MARKETPLACE: "Produce a clean, trustworthy marketplace listing photograph that shows the product accurately and clearly.",
  CREATE_SOCIAL: "Produce an eye-catching, scroll-stopping image suited to a social feed.",
  CREATE_BANNER: "Produce a wide, high-impact promotional image suited to a banner placement.",
  ADD_MODEL: "Introduce a model interacting naturally with the product without upstaging it.",
  CHANGE_MODEL: "Replace the model while keeping the product exactly as it is.",
  EDIT_BACKGROUND: "Replace the background while keeping the subject exactly as it is.",
  CHANGE_SCENE: "Move the subject into a new environment while keeping the subject exactly as it is.",
  CHANGE_LIGHTING: "Re-light the scene to a new mood while keeping the subject exactly as it is.",
  CHANGE_CAMERA: "Re-shoot the same subject from a different camera angle/distance.",
  CHANGE_COMPOSITION: "Re-frame the same subject with a different composition.",
  CHANGE_PROPS: "Update the styling props around the subject without altering the subject itself.",
  CHANGE_COLOR: "Adjust the overall color palette of the image.",
  REMOVE_ELEMENT: "Remove a specific element from the frame without disturbing anything else.",
  ADD_ELEMENT: "Add a specific element to the frame without disturbing anything else.",
  UPSCALE: "Produce a higher-resolution, sharper rendition of the existing image, unchanged in content.",
  VARIATION: "Produce an alternative take on the existing composition.",
  MULTI_VARIATION: "Produce several alternative takes on the existing composition.",
  REGENERATE: "Produce a refreshed rendition of the existing composition.",
};

export interface BuildCreativeBriefInput {
  intent: CreativeIntentValue;
  /** Fully-formed subject phrase, e.g. "the Handbags" or "a pair of
   * sneakers" — see plan-builder.ts's `synthesizeCreativePrompt` doc
   * comment for why callers build this themselves. */
  subjectPhrase: string;
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
  isEditTurn: boolean;
  preservationRequirements: string[];
  /** The product's category (Shopify `productType`/Product Intelligence
   * `category`), when known — used only by the category-aware
   * model-product-interaction rule below (see product-interaction.ts).
   * `null`/omitted for a standalone session with no resolved category
   * (falls back to a physically sensible generic interaction, never a
   * wrong guess — see `resolveProductInteraction`'s own doc comment). */
  category?: string | null;
  /** Which of `style`/`lighting`/`composition`/`camera`/`colorDirection`
   * above were filled in by this user's own learned preference
   * (`services/creative-studio/personalization.server.ts`'s
   * `applyLearnedDefaults`) rather than specified by THIS message — see
   * module doc comment's "Explicit vs. personalized vs. inferred".
   * `[]`/omitted for a Shopify call or a user with no learned preference
   * applied this turn (the common case). */
  personalizedFields?: readonly string[];
  /** A real vendor's own holistic reasoning, when a configured
   * multimodal-capable `IntentParsingProvider` supplied one — see module
   * doc comment. `null`/absent for the heuristic parser (always) and for
   * a real provider that chose not to supply one. */
  externalCreativeDirection?: string | null;
  /** A real vendor's own inferred creative decisions — see module doc
   * comment's "Explicit vs. inferred". `undefined`/empty for the
   * heuristic parser (always) and for a real provider that chose not to
   * supply any. */
  externalInferredCreativeDecisions?: string[] | null;
  /** A real vendor's own unifying visual concept — see
   * `CreativeBrief.creativeConcept`'s doc comment. `null`/absent for the
   * heuristic parser (always — there is no deterministic fallback for
   * this one, see module doc comment) and for a real provider that
   * judged the request too narrow to warrant proposing one. */
  externalCreativeConcept?: string | null;
  /** A real vendor's own deliberate restraint decisions — see
   * `CreativeBrief.negativeCreativeDecisions`'s doc comment.
   * `undefined`/empty for the heuristic parser (always) and for a real
   * provider that chose not to supply any. */
  externalNegativeCreativeDecisions?: string[] | null;
}

/**
 * The small, deterministic "what should a professional creative director
 * add here" rule table — see module doc comment's "Explicit vs.
 * inferred". Each rule is conditioned on an explicit field already being
 * present, so this never invents a creative direction independent of
 * what was actually requested; it only strengthens the EXECUTION of
 * that request. Capped implicitly by how few rules exist — deliberately
 * NOT an exhaustive checklist (Part F's own instruction: "the planner
 * should infer only what is useful").
 */
function inferCreativeDecisions(input: BuildCreativeBriefInput): string[] {
  const decisions: string[] = [];

  // A requested pose/action change: physical plausibility is a real,
  // recurring failure mode (the exact "yoga" worked example) — a pose
  // change without this note risks anatomically implausible results.
  if (input.action) {
    decisions.push("Ensure anatomically plausible, natural body mechanics and weight distribution for the new pose/action.");
  }

  // A requested environment/scene change: subject and background must
  // read as one coherent photograph, not a cutout pasted over a
  // separately-lit background — the exact failure this whole feature was
  // originally built to prevent.
  if (input.scene) {
    decisions.push(
      "Match the subject's perspective, scale, and lighting direction to the new environment so it reads as one coherent photograph, not a cutout pasted onto a separate background.",
    );
  }

  // A nighttime scene specifically: the subject's own lighting must
  // plausibly belong to that environment (the "luxury hotel at night"
  // worked example) — a very common, specific failure mode distinct from
  // the general environment-coherence note above.
  if (input.scene && NIGHT_PATTERN.test(input.scene)) {
    decisions.push("Light the subject to plausibly match the nighttime environment, not daylight lighting with a dark background substituted in.");
  }

  // Explicitly moody/dark/cinematic direction: real cinematography uses
  // deliberate shadow shaping, not a uniform brightness reduction. Also
  // where beautiful lighting most commonly destroys product fidelity
  // (Priority 4 vs. Priority 1 — quality-floor pass) — dramatic lighting
  // must still reveal the product's real materials/edges/texture, never
  // crush detail into pure shadow or blow highlights into pure white.
  const moodyRequested = (input.lighting && MOODY_PATTERN.test(input.lighting)) || input.style.some((s) => MOODY_PATTERN.test(s));
  if (moodyRequested) {
    decisions.push(
      "Use deliberate, motivated shadow and highlight control rather than uniformly darkening the whole frame — keep the product's own details, edges, and texture readable; do not crush them into shadow or blow out their highlights.",
    );
  }

  // A model is being added or changed: the physically/commercially
  // correct interaction depends on the product's category (a ring is
  // worn, a beverage is poured — see product-interaction.ts), never a
  // blanket "the model holds the product." Paired with the human
  // -realism requirements every real photograph of a person needs, so
  // the interaction reads as genuinely photographed contact, not a
  // composite (quality-floor pass, Priority 2 and human realism).
  if (input.intent === "ADD_MODEL" || input.intent === "CHANGE_MODEL") {
    decisions.push(
      `Have the model ${resolveProductInteraction(input.category ?? null, input.action)}, with anatomically correct hands (correct finger count, natural joints, believable grip), realistic skin contact, and no floating or clipped-through product.`,
    );
  }

  // "Premium"/"luxury"-style direction: the sneaker-ad worked example —
  // a real creative director's own contextual judgment (via a real
  // vendor's `externalInferredCreativeDecisions`) should ultimately
  // decide what "premium" means for THIS product; this is the reasonable
  // deterministic default while none is configured.
  const premiumRequested = input.style.some((s) => PREMIUM_PATTERN.test(s));
  if (premiumRequested) {
    decisions.push(
      "Apply controlled, high-end studio-quality lighting, a clean and uncluttered composition, and realistic material/surface rendering (accurate reflections and shadows) befitting premium commercial work.",
    );
  }

  // A fresh, from-scratch commercial/lifestyle image: the subject must
  // stay the visual focal point regardless of how elaborate the
  // background/environment becomes — and, when a model is involved
  // (ADD_MODEL is itself one of these intents), the model and
  // environment exist to sell the product, not to compete with it.
  if (FRESH_CREATIVE_INTENTS.has(input.intent)) {
    decisions.push(
      "Keep the product visually dominant as the immediate visual hero, using foreground, midground, background, crop, and negative space deliberately; neither the model (if any) nor the environment should visually overpower it.",
    );

    const materialDecision = MATERIAL_CATEGORY_PATTERNS.find(({ pattern }) => pattern.test(input.category ?? input.subjectPhrase))?.decision;
    if (materialDecision) decisions.push(materialDecision);
  }

  return decisions;
}

/**
 * The small, deterministic "what should a professional creative director
 * deliberately leave OUT" rule table — see module doc comment's
 * "creativeConcept and negativeCreativeDecisions". Deliberately paired
 * 1:1 with `inferCreativeDecisions`'s subject-dominance rule above
 * (asserting the subject should be dominant, and asserting nothing
 * should be allowed to compete with it, are two halves of the same
 * decision) rather than a separate, larger rule set of its own — the
 * intent is a real, honest floor, not a simulation of genuine restraint
 * judgment (that belongs to the real LLM path — see
 * `externalNegativeCreativeDecisions`).
 */
function inferNegativeCreativeDecisions(input: BuildCreativeBriefInput): string[] {
  const decisions: string[] = [];

  if (FRESH_CREATIVE_INTENTS.has(input.intent)) {
    decisions.push("Avoid a generic background/environment that competes with or overshadows the subject.");
  }

  if (input.intent === "ADD_MODEL" || input.intent === "CHANGE_MODEL") {
    decisions.push(
      "Avoid distorted anatomy, implausible hands, incorrect product scale, floating or duplicated products, or product contact that clips through or fuses with the body.",
    );
    decisions.push("Avoid poses, wardrobe, hair, or accessories that obscure the product's defining details or the body region where it is worn or used.");
  }

  const moodyRequested = (input.lighting && MOODY_PATTERN.test(input.lighting)) || input.style.some((style) => MOODY_PATTERN.test(style));
  if (moodyRequested) {
    decisions.push("Avoid excessive darkness, clipped highlights, or saturated grading that hides the product's material and important detail.");
  }

  if (input.depthOfField && SHALLOW_DEPTH_PATTERN.test(input.depthOfField)) {
    decisions.push("Avoid blur across the product's key detail plane; reserve soft focus for depth separation around the hero product.");
  }

  if (input.addElements.length > 0) {
    decisions.push("Avoid unrequested decorative accessories or extra props that compete with the requested additions and the hero product.");
  }

  if (/\b(cosmetics?|beauty|skincare|makeup|glass|bottle|fragrance|perfume)\b/i.test(input.category ?? input.subjectPhrase)) {
    decisions.push("Avoid invented packaging copy or unreadable product labeling.");
  }

  return decisions;
}

interface TaggedEntry {
  /** The `BuildCreativeBriefInput` field this entry came from — only
   * ever one of `personalization.server.ts`'s `LEARNABLE_FIELDS`
   * ("style"/"lighting"/"composition"/"camera"/"colorDirection") can
   * possibly appear in a caller's `personalizedFields` list, so only
   * entries tagged with one of those five are ever eligible to be
   * reclassified as `personalizationApplied` below. */
  field: string;
  entry: string;
}

/** Every "dimension: value" entry this turn's EFFECTIVE creative fields
 * describe, each tagged with which field it came from — `buildCreativeBrief`
 * splits these into `transformationRequirements` (explicit) vs.
 * `personalizationApplied` (filled in by learned preference) using that
 * tag, rather than this function needing to know about personalization
 * at all. */
function transformationEntries(input: BuildCreativeBriefInput): TaggedEntry[] {
  const entries: TaggedEntry[] = [];
  if (input.action) entries.push({ field: "action", entry: `pose/action: ${input.action}` });
  if (input.scene) entries.push({ field: "scene", entry: `environment: ${input.scene}` });
  if (input.lighting) entries.push({ field: "lighting", entry: `lighting: ${input.lighting}` });
  if (input.composition) entries.push({ field: "composition", entry: `composition: ${input.composition}` });
  if (input.camera) entries.push({ field: "camera", entry: `camera: ${input.camera}` });
  if (input.colorDirection) entries.push({ field: "colorDirection", entry: `color palette: ${input.colorDirection}` });
  if (input.depthOfField) entries.push({ field: "depthOfField", entry: `depth of field: ${input.depthOfField}` });
  if (input.style.length > 0) entries.push({ field: "style", entry: `visual style: ${input.style.join(", ")}` });
  if (input.addElements.length > 0) entries.push({ field: "addElements", entry: `add: ${input.addElements.join(", ")}` });
  if (input.removeElements.length > 0) entries.push({ field: "removeElements", entry: `remove: ${input.removeElements.join(", ")}` });
  if (input.colorOverride) entries.push({ field: "colorOverride", entry: `product color: ${input.colorOverride}` });
  if (input.materialOverride) entries.push({ field: "materialOverride", entry: `product material: ${input.materialOverride}` });
  return entries;
}

/**
 * Real, deterministic prose composition — grouped into up to three
 * connected sentences (preserve / transform / finish) rather than a flat
 * comma-joined list, so the result reads as one creative decision. This
 * is what makes `overallCreativeDirection` genuinely different from
 * `plan-builder.ts`'s existing atomic-field prompt clauses, not a
 * renamed copy of them.
 */
function composeOverallCreativeDirection(
  input: BuildCreativeBriefInput,
  transformations: string[],
  personalizationApplied: string[],
  inferred: string[],
): string {
  const objective = INTENT_OBJECTIVE[input.intent];
  const sentences: string[] = [objective];

  if (input.preservationRequirements.length > 0) {
    sentences.push(
      `Keep ${input.subjectPhrase} fully recognizable throughout — ${input.preservationRequirements.join(", ")} must remain exactly as shown.`,
    );
  } else if (input.isEditTurn) {
    sentences.push(`Keep ${input.subjectPhrase}'s identity fully recognizable from the reference image throughout.`);
  }

  if (transformations.length > 0) {
    sentences.push(
      `${input.isEditTurn ? "From that starting point, change" : "Establish"} the following so the final image actually reflects the request: ${transformations.join("; ")}.`,
    );
  }

  // Priority model (see this project's "explicit > personalization >
  // inference" ordering): a personalized default is only ever real
  // evidence about dimensions THIS message left unspecified — stated as
  // its own, clearly-conditioned clause, never merged into the explicit
  // clause above, so the prompt itself can never make a learned habit
  // look like something the merchant asked for this turn.
  if (personalizationApplied.length > 0) {
    sentences.push(`This merchant's own usual preference, applied only because this request didn't specify it: ${personalizationApplied.join("; ")}.`);
  }

  if (input.style.length > 0) {
    sentences.push(`The overall result should feel ${input.style.join(", ")}, not a generic default.`);
  }

  // WHAT A PROFESSIONAL CREATIVE DIRECTOR SHOULD INFER — kept as its own,
  // clearly-attributed closing sentence (never merged into the explicit
  // transformation clause above) so the prompt itself preserves the same
  // explicit-vs-inferred distinction the structured `CreativeBrief` does.
  if (inferred.length > 0) {
    sentences.push(`As the creative director on this shot, also ensure: ${inferred.join("; ")}.`);
  }

  return sentences.join(" ");
}

/**
 * The ONLY field names `buildCreativeBrief` will ever reclassify as
 * `personalizationApplied` — mirrors
 * `personalization.server.ts`'s `LEARNABLE_FIELDS` exactly. This is a
 * structural guard, not just a convention followed by today's one real
 * caller: request-specific CONTENT (`action`/`scene`/`addElements`/
 * `removeElements`/the attribute overrides) can NEVER be personalization
 * -sourced by design (personalization never learns a subject/scene/
 * action — see that file's own doc comment), so even a future caller
 * bug that passed one of those names in `personalizedFields` could never
 * make an explicit request look like a learned habit.
 */
const PERSONALIZABLE_ENTRY_FIELDS: ReadonlySet<string> = new Set(["style", "lighting", "composition", "camera", "colorDirection"]);

export function buildCreativeBrief(input: BuildCreativeBriefInput): CreativeBrief {
  const allEntries = transformationEntries(input);
  const personalizedSet = new Set((input.personalizedFields ?? []).filter((field) => PERSONALIZABLE_ENTRY_FIELDS.has(field)));
  const transformations = allEntries.filter((e) => !personalizedSet.has(e.field)).map((e) => e.entry);
  const personalizationApplied = allEntries.filter((e) => personalizedSet.has(e.field)).map((e) => e.entry);
  const importantElements = [...(input.scene ? [input.scene] : []), ...(input.action ? [input.action] : []), ...input.addElements];

  const inferredCreativeDecisions =
    input.externalInferredCreativeDecisions && input.externalInferredCreativeDecisions.length > 0
      ? input.externalInferredCreativeDecisions
      : inferCreativeDecisions(input);

  const negativeCreativeDecisions =
    input.externalNegativeCreativeDecisions && input.externalNegativeCreativeDecisions.length > 0
      ? input.externalNegativeCreativeDecisions
      : inferNegativeCreativeDecisions(input);

  // No deterministic fallback — see module doc comment for why genuine
  // concept development is deliberately left to the real LLM path only.
  const creativeConcept =
    input.externalCreativeConcept && input.externalCreativeConcept.trim().length > 0 ? input.externalCreativeConcept.trim() : null;

  // A real vendor's own holistic sentence is assumed to already fold in
  // its own creative-director reasoning (it IS the creative-director
  // reasoning) — the deterministic `inferredCreativeDecisions`/
  // `personalizationApplied` lists are still computed and persisted
  // either way (traceability, tests), but only appended into the
  // COMPOSED sentence, never spliced into a real vendor's own prose.
  const overallCreativeDirection =
    input.externalCreativeDirection && input.externalCreativeDirection.trim().length > 0
      ? input.externalCreativeDirection.trim()
      : composeOverallCreativeDirection(input, transformations, personalizationApplied, inferredCreativeDecisions);

  return {
    creativeObjective: INTENT_OBJECTIVE[input.intent],
    subjectTreatment: input.action ? `natural, in the middle of ${input.action}, not stiffly posed` : null,
    preservationRequirements: input.preservationRequirements,
    transformationRequirements: transformations,
    personalizationApplied,
    importantElements,
    inferredCreativeDecisions,
    creativeConcept,
    negativeCreativeDecisions,
    overallCreativeDirection,
  };
}
