/**
 * The default, always-available `IntentParsingProvider` — a genuinely
 * real, deterministic, RULE-BASED implementation (keyword/pattern
 * matching), not a placeholder and not gated to tests-only the way
 * services/generation/deterministic-test-provider.server.ts is.
 *
 * This is a deliberate departure from every other provider in this
 * codebase's "Unconfigured until a real vendor is wired up" convention
 * (see services/ai/unconfigured-provider.ts). The reasoning: Creative
 * Studio's entire point is the conversational interaction — if intent
 * parsing itself only ever threw "not configured" outside tests, the
 * feature would be unusable in production with zero AI vendor
 * credentials configured, which defeats "Build a production-grade
 * conversational... experience" (see the Creative Studio instructions,
 * Part 2). Image GENERATION stays governed by the existing, unchanged
 * resolver (services/generation/provider.server.ts) — it still honestly
 * fails with "Image generation isn't configured for this store yet" when
 * no real vendor is set, exactly as every other generationType already
 * does. Only the INTERPRETATION step (turning a sentence into structure)
 * has a real, useful, non-AI default — see docs/creative-studio.md
 * "Provider abstraction" for the full reasoning and its honest
 * limitations.
 *
 * This is NOT a real language model. It correctly categorizes common,
 * plainly-worded ecommerce photography requests via keyword/pattern
 * matching — it does not understand novel phrasing, sarcasm, negation
 * nuance, or genuinely ambiguous instructions the way a real LLM-backed
 * `IntentParsingProvider` would. `services/ai/production-image-generation-provider.server.ts`
 * establishes the pattern for what a real vendor implementation looks
 * like when one is selected later — this file's `IntentParsingProvider`
 * interface conformance means a future real parser is a drop-in
 * replacement (services/creative-studio/provider.server.ts's resolver),
 * no call site changes required.
 */
import type { IntentParsingProvider, ParseIntentInput, ParsedIntentRawOutput } from "./types";
import type { CreativeIntentValue, GenerationModeValue } from "../creative-studio/types";

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  a: 1,
  couple: 2,
  few: 3,
};

const STYLE_KEYWORDS = [
  "premium",
  "luxury",
  "minimal",
  "minimalist",
  "clean",
  "modern",
  "commercial",
  "editorial",
  "bold",
  "elegant",
  "natural",
  "vintage",
  "rustic",
  "moody",
  "bright and airy",
];

const LIGHTING_PATTERN = /\b((?:warm|cool|soft|bright|dim|golden|natural|dramatic|studio)\s+(?:[a-z]+\s+){0,2}?(?:light|lighting|sunlight|sunshine))\b/i;
// Bare "bright"/"dark" (not only their comparative forms) are just as
// common a way to request a lighting mood ("make the background dark")
// and were previously missed entirely.
const BRIGHTER_PATTERN = /\b(brighter|bright|more light|lighter)\b/i;
const DARKER_PATTERN = /\b(darker|dark|dimmer|dim|moody|moodier|moody lighting|low-key)\b/i;

// Pose/activity extraction (see intent-schema.ts's `action` doc
// comment) — deliberately verb-TRIGGERED, not an enumerated list of
// specific activities (never "yoga"-specific): "do/perform/practice/
// pose" + a noun phrase covers "perform yoga," "do a handstand,"
// "practice meditation," "pose dramatically," etc. without hardcoding
// any one activity. A second, gerund-form alternative catches phrasing
// like "make her sitting on the floor" / "show him meditating."
// No separate article-consuming group before the capture — a leading
// "a"/"an" (if present, e.g. "doing a handstand") stays part of the
// captured phrase so it reads naturally in the prompt ("performing a
// handstand", not "performing handstand").
const ACTION_PATTERN =
  /\b(?:do|does|doing|perform|performs|performing|practice|practices|practicing|pose|poses|posing)\s+([a-z][a-z\s]{2,40}?)(?=[.,!]|\s+(?:with|and|in|at|on|by|while)\b|$)/i;
const GERUND_ACTION_PATTERN =
  /\b(?:her|him|them|it|the model)\s+([a-z]+ing(?:\s+[a-z]+){0,4}?)(?=[.,!]|\s+(?:with|and|in|at|on|by|while)\b|$)/i;

const CAMERA_PATTERN = /\b(eye[- ]level|overhead|45[- ]degree|low angle|high angle|macro|close[- ]up|top[- ]down)\b/i;
const COLOR_DIRECTION_PATTERN = /\b(warm tones|cool tones|monochrome|pastel|vibrant colou?rs?|muted colou?rs?)\b/i;
/** A genuinely distinct creative dimension from `composition`/`camera` —
 * how sharp vs. blurred the space around the subject reads. Deliberately
 * a small, symmetric pair of patterns (shallow vs. deep), not an
 * exhaustive photography-jargon taxonomy — see intent-schema.ts's
 * `depthOfField` doc comment. */
const SHALLOW_DEPTH_OF_FIELD_PATTERN =
  /\b(shallow depth of field|blurr?y?e?d?\s+background|background\s+(?:is\s+)?blurr?y?e?d?|bokeh|out[- ]of[- ]focus background)\b/i;
const DEEP_DEPTH_OF_FIELD_PATTERN = /\b(deep depth of field|deep focus|everything (?:in focus|sharp))\b/i;

// The article after the preposition is now OPTIONAL ("at beach" as well
// as "at a beach") — casual phrasing routinely drops it, and requiring
// it silently dropped the scene entirely for a message like "sneakers
// at beach with cloudy background" (a real production case — see
// docs/creative-studio.md "Standalone subject extraction").
const SCENE_PATTERN = /\b(?:in|on|at|to)\s+(?:(?:a|an|the)\s+)?([a-z][a-z\s]{2,50}?)(?=\s+with\b|\s+and\b|[.,!]|$)/i;

// Standalone-only "what is being generated" extraction (see
// intent-schema.ts's `subject` doc comment). Deliberately generic — no
// product-specific vocabulary — a deterministic TWO-STAGE match, not
// one big regex with an optional leading verb clause: an optional outer
// group that CAN match empty lets the engine backtrack away from the
// verb entirely the moment something later fails (e.g. a pronoun
// lookahead — see below), at which point the capture has nothing left
// to stop it and swallows the verb itself as if it were the subject
// ("Make it brighter" → "Make it brighter"). Splitting into two
// deterministic steps closes that hole:
//
//   1. `TRIGGER_PREFIX` — REQUIRED, not optional: a
//      "please create/generate/make/design/produce/show me" opener.
//      Every one of this feature's own worked examples opens this way.
//      No match here means no extraction is attempted at all — a
//      message with no such opener (a bare "Make it brighter," a plain
//      "Regenerate this") is far more likely to be a follow-up edit
//      than a fresh subject declaration, and guessing wrong here is
//      worse than returning null (the caller already has a safe
//      fallback chain — this session's own carried-forward subject, or
//      the generic "product" placeholder).
//   2. `SUBJECT_CAPTURE_PATTERN` — runs only on the remainder AFTER the
//      trigger clause is stripped, so there's no verb left for a failed
//      lookahead to fall back onto: an OPTIONAL throwaway prefix
//      (article, the word "product," an image-noun — "image"/"photo"/
//      "photograph"/"picture" — "of"/"for," another article, covering
//      "an image of," "a product photo of," "a picture for," in any
//      combination actually present), then the captured subject itself,
//      stopping at the first scene-introducing preposition, punctuation,
//      or end of string — the same boundary set `SCENE_PATTERN` starts
//      from, so "subject" and "scene" never overlap. A negative
//      lookahead still rejects a bare pronoun as the subject ("Make it
//      brighter" → afterTrigger "it brighter" → lookahead rejects "it"
//      → no match at all, not "it brighter").
const TRIGGER_PREFIX = /^(?:please\s+)?(?:create|generate|make|design|produce|show)\s+(?:me\s+)?/i;
const SUBJECT_CAPTURE_PATTERN =
  /^(?:(?:an?|the)\s+)?(?:product\s+)?(?:image|photo|photograph|picture)?s?\s*(?:of|for)?\s*(?:(?:an?|the)\s+)?(?!it\b|this\b|that\b|them\b|those\b|these\b|its\b)([a-z][a-z0-9\s-]{1,80}?)(?=\s+(?:at|in|on|near|through|against|by|with|and)\b|[.,!]|$)/i;

// A subject capture can end up carrying a trailing generic image-noun
// ("premium sneaker image" from "...sneaker image on a beach") — strip
// it, it describes the ASSET, not the subject.
const TRAILING_IMAGE_NOUN_PATTERN = /\s+(images?|photos?|photographs?|pictures?)$/i;

const ADD_MODEL_PATTERN = /\b(add|include|show|put)\b.{0,20}\b(a |an )?(model|woman|man|person|hand|someone)\b.{0,20}\bholding\b/i;
const ADD_MODEL_SIMPLE_PATTERN = /\b(add|include)\b.{0,15}\b(a |an )?(model|woman|man|person)\b/i;
const CHANGE_MODEL_PATTERN = /\b(different|another|change the|swap the)\s+model\b/i;
const REMOVE_PATTERN = /\b(?:remove|get rid of|take out|without)\s+(?:the|a|an)?\s*([a-z][a-z\s]{2,40}?)(?=[.,!]|$)/i;
const ADD_GENERIC_PATTERN = /\b(?:add|include)\s+(?:a|an|some)?\s*([a-z][a-z\s]{2,40}?)(?=\s+to\b|\s+holding\b|[.,!]|$)/i;
// "Change her dress to a red evening gown" is a TRANSFORM, not an ADD —
// captured separately (into `addElements` as "wearing X") since
// ADD_GENERIC_PATTERN's own "add/include" trigger doesn't match
// "change...to" phrasing at all. A bounded, common clothing-noun list
// (not one hardcoded garment) covers the general class of "swap what
// the subject is wearing" requests without inventing a whole new field.
const CLOTHING_CHANGE_PATTERN =
  /\b(?:change|turn|make)\s+(?:her|his|their|the)\s+(?:dress|outfit|clothes|clothing|attire|top|shirt|gown)\s+(?:to|into)\s+([a-z][a-z\s]{2,40}?)(?=[.,!]|\s+(?:with|and)\b|$)/i;

const KEEP_SAME_PATTERN = /\b(keep|leave)\b.{0,15}\b(the )?product\b.{0,20}\b(exactly the same|unchanged|as is|as-is)\b/i;
const PRESERVE_PATTERN = /\bdon'?t (change|alter|modify)\b.{0,15}\bproduct\b/i;

const ORDINAL_PATTERN = /\b(first|second|third|fourth|last|previous)\b(?:\s+(?:one|version|option|result|variation))?/i;

// Creative-override extraction (Part 2) — deliberately narrow, named
// patterns, not a general free-text capture: "make the bottle black" /
// "make it red" → color override; "make it out of/from/in wood" →
// material override. See intent-schema.ts's `attributeOverrides` doc
// comment for why this stays a small structured field set.
const COLOR_WORDS = [
  "black",
  "white",
  "red",
  "blue",
  "green",
  "yellow",
  "pink",
  "purple",
  "orange",
  "brown",
  "gray",
  "grey",
  "gold",
  "silver",
  "beige",
  "navy",
  "cream",
  "ivory",
];
// Two forms, both verb-and-color-word gated (never a bare "the bottle is
// red" description — that's a fact, not a request). The "into"/"to"
// -phrased form ("turn this red bottle into a blue bottle", "change it to
// blue") is tried FIRST — deliberately: if the direct-object form were
// tried first, "turn this red bottle into a blue bottle" would wrongly
// match as "turn this [red]" and capture the product's CURRENT color
// (red) instead of the requested target color (blue), since "red" itself
// satisfies the direct-object form's own color-word slot. Trying the
// "into"/"to" form first means a message containing both an original and
// a target color always resolves to the target. The direct-object form
// ("make/turn/change it/the bottle red") is the fallback for phrasing
// with no second, competing color word. A non-greedy `.{0,30}?` lets the
// "into"/"to" form tolerate descriptive words between the verb and
// "into"/"to" ("turn THIS RED BOTTLE into blue"). See
// docs/creative-studio.md "Creative overrides" worked example.
const COLOR_OVERRIDE_PATTERN = new RegExp(
  `\\b(?:turn|change)\\s+(?:it|this|that|the)\\b.{0,30}?\\b(?:into|to)\\s+(?:a\\s+|an\\s+)?(${COLOR_WORDS.join("|")})\\b` +
    `|\\b(?:make|turn|change)\\s+(?:it|this|that|the\\s+[a-z]+)\\s+(${COLOR_WORDS.join("|")})\\b`,
  "i",
);
const MATERIAL_OVERRIDE_PATTERN =
  /\b(?:make|turn|change)\s+(?:it|this|that|the\s+[a-z]+)\s+(?:out of|from|in)\s+([a-z][a-z\s]{2,30}?)(?=[.,!]|$)/i;

function extractVariationCount(message: string): number | null {
  const explicitDigit = message.match(/\b(\d+)\s+(?:variations?|options?|alternatives?|versions?)\b/i);
  if (explicitDigit) {
    const n = Number(explicitDigit[1]);
    if (Number.isFinite(n) && n >= 1) return Math.min(n, 4);
  }
  const wordMatch = message.match(/\b(one|two|three|four|a couple of|couple of|a few|few)\s+(?:variations?|options?|alternatives?|versions?)\b/i);
  if (wordMatch) {
    const key = wordMatch[1].replace(/^a\s+/, "").split(" ")[0];
    const n = NUMBER_WORDS[key];
    if (n) return Math.min(n, 4);
  }
  const giveMePattern = message.match(/\bgive me\s+(\d+)\b/i);
  if (giveMePattern) {
    const n = Number(giveMePattern[1]);
    if (Number.isFinite(n) && n >= 1) return Math.min(n, 4);
  }
  return null;
}

function extractScene(message: string): string | null {
  const match = SCENE_PATTERN.exec(message);
  if (!match) return null;
  return match[1].trim().replace(/\s+/g, " ");
}

/** See `TRIGGER_PREFIX`/`SUBJECT_CAPTURE_PATTERN`'s doc comment and
 * intent-schema.ts's `subject` field. Returns `null`, never a bare
 * pronoun/empty string/the raw message, when nothing usable was found;
 * the caller (plan-builder.ts, for a standalone session only) is
 * responsible for the "nothing extracted" fallback. */
function extractSubject(message: string): string | null {
  const trimmed = message.trim();
  const afterTrigger = trimmed.replace(TRIGGER_PREFIX, "");
  if (afterTrigger === trimmed) return null; // no recognized trigger clause — nothing safely extractable
  const match = SUBJECT_CAPTURE_PATTERN.exec(afterTrigger);
  if (!match) return null;

  let subject = match[1].trim().replace(/\s+/g, " ");
  subject = subject.replace(TRAILING_IMAGE_NOUN_PATTERN, "").trim();

  // A leading STYLE_KEYWORDS token ("premium sneaker" → "premium" +
  // "sneaker") is already captured separately as `style` — strip it here
  // so it isn't duplicated inside the subject phrase too.
  const words = subject.split(" ");
  while (words.length > 1 && STYLE_KEYWORDS.includes(words[0].toLowerCase())) {
    words.shift();
  }
  subject = words.join(" ").trim();

  return subject.length > 0 ? subject : null;
}

function extractStyle(message: string): string[] {
  const lower = message.toLowerCase();
  return STYLE_KEYWORDS.filter((keyword) => lower.includes(keyword));
}

function extractLighting(message: string): string | null {
  const phraseMatch = LIGHTING_PATTERN.exec(message);
  if (phraseMatch) return phraseMatch[1].trim();
  if (BRIGHTER_PATTERN.test(message)) return "brighter lighting";
  if (DARKER_PATTERN.test(message)) return "darker, moodier lighting";
  return null;
}

function extractCamera(message: string): string | null {
  const match = CAMERA_PATTERN.exec(message);
  return match ? match[1].toLowerCase() : null;
}

function extractColorDirection(message: string): string | null {
  const match = COLOR_DIRECTION_PATTERN.exec(message);
  return match ? match[1].toLowerCase() : null;
}

function extractDepthOfField(message: string): string | null {
  if (SHALLOW_DEPTH_OF_FIELD_PATTERN.test(message)) return "shallow depth of field, background softly blurred";
  if (DEEP_DEPTH_OF_FIELD_PATTERN.test(message)) return "deep focus, background sharp";
  return null;
}

/** See `ACTION_PATTERN`/`GERUND_ACTION_PATTERN`'s doc comment and
 * intent-schema.ts's `action` field. Tries the verb-triggered form
 * first ("perform yoga"); the gerund-after-referent form is a
 * secondary catch for phrasing that doesn't use one of those trigger
 * verbs ("make her sitting on the floor"). Returns `null`, never
 * throws, when neither matches. */
function extractAction(message: string): string | null {
  const match = ACTION_PATTERN.exec(message) ?? GERUND_ACTION_PATTERN.exec(message);
  if (!match) return null;
  const action = match[1].trim().replace(/\s+/g, " ");
  return action.length > 0 ? action : null;
}

function extractAddElements(message: string): string[] {
  const elements: string[] = [];
  const modelMatch = ADD_MODEL_PATTERN.exec(message) ?? ADD_MODEL_SIMPLE_PATTERN.exec(message);
  if (modelMatch) elements.push("a model holding the product");
  const generic = ADD_GENERIC_PATTERN.exec(message);
  if (generic && !/model|woman|man|person/i.test(generic[1])) {
    elements.push(generic[1].trim());
  }
  const clothingChange = CLOTHING_CHANGE_PATTERN.exec(message);
  if (clothingChange) elements.push(`wearing ${clothingChange[1].trim()}`);
  return elements;
}

function extractRemoveElements(message: string): string[] {
  const match = REMOVE_PATTERN.exec(message);
  return match ? [match[1].trim()] : [];
}

function extractPreserveHints(message: string): string[] {
  const hints: string[] = [];
  if (KEEP_SAME_PATTERN.test(message) || PRESERVE_PATTERN.test(message)) {
    hints.push("product identity", "product geometry", "packaging", "label", "branding", "material", "color");
  }
  return hints;
}

function extractTargetResultReference(message: string): string | null {
  const match = ORDINAL_PATTERN.exec(message);
  return match ? match[1].toLowerCase() : null;
}

function extractAttributeOverrides(message: string): { color: string | null; material: string | null } {
  const colorMatch = COLOR_OVERRIDE_PATTERN.exec(message);
  const materialMatch = MATERIAL_OVERRIDE_PATTERN.exec(message);
  // COLOR_OVERRIDE_PATTERN has two alternatives (direct-object form vs.
  // "into"-phrased form) — only one of its two capture groups is ever
  // populated per match, never both.
  const color = colorMatch ? (colorMatch[1] ?? colorMatch[2]) : undefined;
  return {
    color: color ? color.toLowerCase() : null,
    material: materialMatch ? materialMatch[1].trim().toLowerCase() : null,
  };
}

/**
 * Scores every candidate intent against the message and picks the
 * highest-scoring one — a simple, transparent, and testable rule table
 * rather than a black-box classifier. Ties break by the array's own
 * order (most-specific/least-ambiguous intents listed first).
 */
function classifyIntent(message: string, hasExplicitVariationCount: boolean, hasCurrentResult: boolean): CreativeIntentValue {
  const lower = message.toLowerCase();
  const rules: Array<[CreativeIntentValue, boolean]> = [
    ["MULTI_VARIATION", hasExplicitVariationCount],
    ["REGENERATE", /\b(regenerate|redo|try again|do (it |this )?again)\b/i.test(lower)],
    ["ADD_MODEL", ADD_MODEL_PATTERN.test(message) || ADD_MODEL_SIMPLE_PATTERN.test(message)],
    ["CHANGE_MODEL", CHANGE_MODEL_PATTERN.test(message)],
    ["REMOVE_ELEMENT", REMOVE_PATTERN.test(message)],
    ["UPSCALE", /\b(upscale|higher resolution|sharper|hd|4k|higher quality)\b/i.test(lower)],
    ["CREATE_BANNER", /\bbanner\b/i.test(lower)],
    ["CREATE_SOCIAL", /\b(instagram|tiktok|social media|social post)\b/i.test(lower)],
    ["CREATE_MARKETPLACE", /\b(amazon|marketplace|white background|ecommerce listing|product listing)\b/i.test(lower)],
    // A generic advertising/campaign request with no more specific
    // channel keyword (banner/social/marketplace already matched above)
    // — "create an ad for this product", "create a campaign visual",
    // "make a launch creative" — resolves to CREATE_SOCIAL, the closest
    // existing channel-deliverable intent, rather than silently falling
    // through to the generic CREATE_LIFESTYLE default (a real, once
    // -confirmed gap: an advertising request with no reference to an
    // existing result was previously misclassified as ordinary lifestyle
    // photography, losing its campaign-deliverable treatment entirely —
    // see services/creative-studio/creative-blueprint.ts's
    // `ReferenceExecutionStrategy`).
    ["CREATE_SOCIAL", /\b(ad|advertisement|advertising|campaign|promo|promotional|launch)\b/i.test(lower)],
    ["CHANGE_COLOR", COLOR_OVERRIDE_PATTERN.test(message) || (/\bcolou?r\b/i.test(lower) && /\b(change|make it|different)\b/i.test(lower))],
    ["CHANGE_LIGHTING", LIGHTING_PATTERN.test(message) || BRIGHTER_PATTERN.test(message) || DARKER_PATTERN.test(message)],
    ["CHANGE_CAMERA", CAMERA_PATTERN.test(message) && /\b(angle|camera|shot|zoom)\b/i.test(lower)],
    ["CHANGE_COMPOSITION", /\b(composition|crop|frame|layout|centered)\b/i.test(lower)],
    ["CHANGE_PROPS", /\bprops?\b/i.test(lower)],
    ["ADD_ELEMENT", ADD_GENERIC_PATTERN.test(message)],
    // "background" is a more specific signal than a bare scene phrase —
    // checked before the generic CREATE_LIFESTYLE/CHANGE_SCENE fallbacks
    // below so "change the background to X" is never miscategorized as
    // "start a whole new lifestyle scene."
    ["EDIT_BACKGROUND", /\bbackground\b/i.test(lower)],
    ["CREATE_LIFESTYLE", /\blifestyle\b/i.test(lower)],
    ["CHANGE_SCENE", SCENE_PATTERN.test(message) && hasCurrentResult],
    ["VARIATION", /\b(another|one more|different version|alternative)\b/i.test(lower)],
    // A scene phrase with no current result yet and no more specific
    // signal above — the general-purpose "put my product in a scene"
    // starting point (see docs/creative-studio.md's own worked example).
    ["CREATE_LIFESTYLE", SCENE_PATTERN.test(message) && !hasCurrentResult],
  ];

  for (const [intent, matched] of rules) {
    if (matched) return intent;
  }

  // No rule matched — the safest, least-destructive default is a plain
  // variation of whatever currently exists (never silently reinterpret
  // an unrecognized message as a scene/model/element change).
  return hasCurrentResult ? "VARIATION" : "CREATE_LIFESTYLE";
}

function inferMode(intent: CreativeIntentValue, hasCurrentResult: boolean): GenerationModeValue {
  if (!hasCurrentResult) return "TEXT_TO_IMAGE";
  if (intent === "VARIATION" || intent === "MULTI_VARIATION" || intent === "REGENERATE") return "VARIATION";
  if (intent === "ADD_ELEMENT" || intent === "REMOVE_ELEMENT" || intent === "ADD_MODEL" || intent === "CHANGE_MODEL") {
    return "IMAGE_EDIT";
  }
  return "IMAGE_TO_IMAGE";
}

function buildChangeSummary(intent: CreativeIntentValue, fields: {
  scene: string | null;
  style: string[];
  lighting: string | null;
  addElements: string[];
  removeElements: string[];
  variationCount: number;
}): string {
  const parts: string[] = [];
  if (fields.scene) parts.push(`scene: ${fields.scene}`);
  if (fields.style.length > 0) parts.push(`style: ${fields.style.join(", ")}`);
  if (fields.lighting) parts.push(`lighting: ${fields.lighting}`);
  if (fields.addElements.length > 0) parts.push(`add: ${fields.addElements.join(", ")}`);
  if (fields.removeElements.length > 0) parts.push(`remove: ${fields.removeElements.join(", ")}`);
  if (fields.variationCount > 1) parts.push(`${fields.variationCount} variations`);
  if (parts.length === 0) return `${intent.toLowerCase().replace(/_/g, " ")} requested`;
  return parts.join("; ");
}

export class HeuristicIntentParser implements IntentParsingProvider {
  readonly name = "heuristic";

  async parseIntent(input: ParseIntentInput): Promise<ParsedIntentRawOutput> {
    const { message } = input;
    const hasCurrentResult = input.candidateResultCount > 0;

    const explicitVariationCount = extractVariationCount(message);
    const variationCount = explicitVariationCount ?? 1;

    const intent = classifyIntent(message, explicitVariationCount !== null && explicitVariationCount > 1, hasCurrentResult);
    const mode = inferMode(intent, hasCurrentResult);

    const subject = extractSubject(message);
    const action = extractAction(message);
    const scene = extractScene(message);
    const style = extractStyle(message);
    const lighting = extractLighting(message);
    const composition = /\b(advertisement|advertising|campaign|commercial)\b/i.test(message)
      ? "commercial product advertising"
      : null;
    const camera = extractCamera(message);
    const colorDirection = extractColorDirection(message);
    const depthOfField = extractDepthOfField(message);
    const addElements = extractAddElements(message);
    const removeElements = extractRemoveElements(message);
    const preserveHints = extractPreserveHints(message);
    const targetResultReference = extractTargetResultReference(message);
    const attributeOverrides = extractAttributeOverrides(message);

    return {
      intent,
      mode,
      subject,
      action,
      scene,
      style,
      lighting,
      composition,
      camera,
      colorDirection,
      depthOfField,
      addElements,
      removeElements,
      variationCount,
      targetResultReference,
      preserveHints,
      attributeOverrides,
      changeSummary: buildChangeSummary(intent, { scene, style, lighting, addElements, removeElements, variationCount }),
      confidence: 1,
    };
  }
}
