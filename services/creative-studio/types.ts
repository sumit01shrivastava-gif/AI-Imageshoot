/**
 * Creative Studio taxonomy and its supporting shared types — the
 * conversational counterpart to services/generation/types.ts. Kept as
 * plain string-literal unions (not imported from `@prisma/client`) so
 * pure, no-I/O modules in this domain (intent-schema.ts, plan-builder.ts,
 * creative-context.ts) don't need a Prisma import — mirrors
 * services/generation/types.ts's own reasoning exactly.
 *
 * See docs/creative-studio.md "Intent model".
 */

/**
 * Every fine-grained conversational instruction the intent-parsing layer
 * (services/ai/heuristic-intent-parser.ts, or a future real one) resolves
 * a merchant's natural-language message to. Deliberately NOT a
 * `GenerationType` — every one of these produces a `GenerationJob` with
 * `generationType: "CREATIVE_STUDIO"`; the specific intent lives in the
 * plan's own `creativeIntent.intent` field instead (see
 * services/generation/schema.ts's `CreativeStudioPlanSchema`). This
 * keeps the top-level generation taxonomy (what KIND of feature created
 * this request) separate from the fine-grained instruction taxonomy
 * (what the merchant actually asked for within that feature) — the same
 * separation `lifestyleScene` already models for LIFESTYLE.
 */
export const CREATIVE_INTENTS = [
  "EDIT_BACKGROUND",
  "CHANGE_SCENE",
  "CHANGE_LIGHTING",
  "CHANGE_CAMERA",
  "CHANGE_COMPOSITION",
  "ADD_MODEL",
  "CHANGE_MODEL",
  "CHANGE_PROPS",
  "CHANGE_COLOR",
  "CREATE_LIFESTYLE",
  "CREATE_MARKETPLACE",
  "CREATE_SOCIAL",
  "CREATE_BANNER",
  "REMOVE_ELEMENT",
  "ADD_ELEMENT",
  "UPSCALE",
  "VARIATION",
  "REGENERATE",
  "MULTI_VARIATION",
] as const;

export type CreativeIntentValue = (typeof CREATIVE_INTENTS)[number];

/**
 * How this generation request relates to a source image — see
 * services/ai/types.ts's `GenerateImageInput.mode` and
 * docs/creative-studio.md "Image-to-image flow". `TEXT_TO_IMAGE`: no
 * prior result exists yet for this session (the first message).
 * `IMAGE_TO_IMAGE`: editing forward from the session's current result
 * (the common conversational-follow-up case — "make it brighter").
 * `IMAGE_EDIT`: a targeted add/remove-element instruction, still
 * image-to-image but semantically an edit rather than a re-scene.
 * `VARIATION`: "give me another one" / "give me 3 options" — same
 * creative direction as the current result, re-run for fresh outputs.
 */
export const GENERATION_MODES = ["TEXT_TO_IMAGE", "IMAGE_TO_IMAGE", "IMAGE_EDIT", "VARIATION"] as const;

export type GenerationModeValue = (typeof GENERATION_MODES)[number];

/** Intents that request MORE THAN ONE output by nature (the merchant's
 * own explicit "give me N options" always wins via the parsed
 * `variationCount`, regardless of intent — this only affects the
 * default when no explicit count was given). */
export const MULTI_OUTPUT_INTENTS: ReadonlySet<CreativeIntentValue> = new Set(["MULTI_VARIATION"]);

/** Intents that always start a fresh scene (no prior result to edit
 * forward from is required, though one may still exist and inform brand
 * style continuity) vs. intents that inherently mean "take the current
 * image and change ONE thing about it" — used by
 * services/creative-studio/plan-builder.ts to pick a sensible default
 * `GenerationModeValue` when the caller doesn't already know (e.g. the
 * session has no current result yet, which forces TEXT_TO_IMAGE
 * regardless of intent). */
export const SCENE_STARTING_INTENTS: ReadonlySet<CreativeIntentValue> = new Set([
  "CREATE_LIFESTYLE",
  "CREATE_MARKETPLACE",
  "CREATE_SOCIAL",
  "CREATE_BANNER",
  "CHANGE_SCENE",
]);
