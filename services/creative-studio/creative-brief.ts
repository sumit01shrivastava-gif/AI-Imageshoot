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
 */
import type { CreativeIntentValue } from "./types";

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
  /** What THIS turn is actually asking to change, grouped as
   * "dimension: value" entries — e.g. "pose/action: yoga",
   * "environment: a dark, atmospheric temple", "lighting: cinematic,
   * moody". This is the direct, assertable evidence a regression test
   * checks for the exact failure class Part P/Q describe: a request
   * naming a pose/environment/lighting change must show up here, not
   * just somewhere inside a prose paragraph. */
  transformationRequirements: string[];
  /** Short noun phrases that must visibly appear in the frame — added
   * elements plus the named scene/action, when present. */
  importantElements: string[];
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
  addElements: string[];
  removeElements: string[];
  colorOverride: string | null;
  materialOverride: string | null;
  isEditTurn: boolean;
  preservationRequirements: string[];
  /** A real vendor's own holistic reasoning, when a configured
   * multimodal-capable `IntentParsingProvider` supplied one — see module
   * doc comment. `null`/absent for the heuristic parser (always) and for
   * a real provider that chose not to supply one. */
  externalCreativeDirection?: string | null;
}

function transformationEntries(input: BuildCreativeBriefInput): string[] {
  const entries: string[] = [];
  if (input.action) entries.push(`pose/action: ${input.action}`);
  if (input.scene) entries.push(`environment: ${input.scene}`);
  if (input.lighting) entries.push(`lighting: ${input.lighting}`);
  if (input.composition) entries.push(`composition: ${input.composition}`);
  if (input.camera) entries.push(`camera: ${input.camera}`);
  if (input.colorDirection) entries.push(`color palette: ${input.colorDirection}`);
  if (input.style.length > 0) entries.push(`visual style: ${input.style.join(", ")}`);
  if (input.addElements.length > 0) entries.push(`add: ${input.addElements.join(", ")}`);
  if (input.removeElements.length > 0) entries.push(`remove: ${input.removeElements.join(", ")}`);
  if (input.colorOverride) entries.push(`product color: ${input.colorOverride}`);
  if (input.materialOverride) entries.push(`product material: ${input.materialOverride}`);
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
function composeOverallCreativeDirection(input: BuildCreativeBriefInput, transformations: string[]): string {
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

  if (input.style.length > 0) {
    sentences.push(`The overall result should feel ${input.style.join(", ")}, not a generic default.`);
  }

  return sentences.join(" ");
}

export function buildCreativeBrief(input: BuildCreativeBriefInput): CreativeBrief {
  const transformations = transformationEntries(input);
  const importantElements = [...(input.scene ? [input.scene] : []), ...(input.action ? [input.action] : []), ...input.addElements];

  const overallCreativeDirection =
    input.externalCreativeDirection && input.externalCreativeDirection.trim().length > 0
      ? input.externalCreativeDirection.trim()
      : composeOverallCreativeDirection(input, transformations);

  return {
    creativeObjective: INTENT_OBJECTIVE[input.intent],
    subjectTreatment: input.action ? `natural, in the middle of ${input.action}, not stiffly posed` : null,
    preservationRequirements: input.preservationRequirements,
    transformationRequirements: transformations,
    importantElements,
    overallCreativeDirection,
  };
}
