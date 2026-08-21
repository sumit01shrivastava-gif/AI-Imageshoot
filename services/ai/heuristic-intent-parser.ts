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
const BRIGHTER_PATTERN = /\b(brighter|more light|lighter)\b/i;
const DARKER_PATTERN = /\b(darker|dimmer|moody lighting)\b/i;

const CAMERA_PATTERN = /\b(eye[- ]level|overhead|45[- ]degree|low angle|high angle|macro|close[- ]up|top[- ]down)\b/i;
const COLOR_DIRECTION_PATTERN = /\b(warm tones|cool tones|monochrome|pastel|vibrant colou?rs?|muted colou?rs?)\b/i;

const SCENE_PATTERN = /\b(?:in|on|at|to)\s+(?:a|an|the)\s+([a-z][a-z\s]{2,50}?)(?=\s+with\b|\s+and\b|[.,!]|$)/i;

const ADD_MODEL_PATTERN = /\b(add|include|show|put)\b.{0,20}\b(a |an )?(model|woman|man|person|hand|someone)\b.{0,20}\bholding\b/i;
const ADD_MODEL_SIMPLE_PATTERN = /\b(add|include)\b.{0,15}\b(a |an )?(model|woman|man|person)\b/i;
const CHANGE_MODEL_PATTERN = /\b(different|another|change the|swap the)\s+model\b/i;
const REMOVE_PATTERN = /\b(?:remove|get rid of|take out|without)\s+(?:the|a|an)?\s*([a-z][a-z\s]{2,40}?)(?=[.,!]|$)/i;
const ADD_GENERIC_PATTERN = /\b(?:add|include)\s+(?:a|an|some)?\s*([a-z][a-z\s]{2,40}?)(?=\s+to\b|\s+holding\b|[.,!]|$)/i;

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
const COLOR_OVERRIDE_PATTERN = new RegExp(`\\bmake\\s+(?:it|the\\s+[a-z]+)\\s+(${COLOR_WORDS.join("|")})\\b`, "i");
const MATERIAL_OVERRIDE_PATTERN = /\bmake\s+(?:it|the\s+[a-z]+)\s+(?:out of|from|in)\s+([a-z][a-z\s]{2,30}?)(?=[.,!]|$)/i;

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

function extractAddElements(message: string): string[] {
  const elements: string[] = [];
  const modelMatch = ADD_MODEL_PATTERN.exec(message) ?? ADD_MODEL_SIMPLE_PATTERN.exec(message);
  if (modelMatch) elements.push("a model holding the product");
  const generic = ADD_GENERIC_PATTERN.exec(message);
  if (generic && !/model|woman|man|person/i.test(generic[1])) {
    elements.push(generic[1].trim());
  }
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
  return {
    color: colorMatch ? colorMatch[1].toLowerCase() : null,
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

    const scene = extractScene(message);
    const style = extractStyle(message);
    const lighting = extractLighting(message);
    const composition = /\b(advertisement|advertising|campaign|commercial)\b/i.test(message)
      ? "commercial product advertising"
      : null;
    const camera = extractCamera(message);
    const colorDirection = extractColorDirection(message);
    const addElements = extractAddElements(message);
    const removeElements = extractRemoveElements(message);
    const preserveHints = extractPreserveHints(message);
    const targetResultReference = extractTargetResultReference(message);
    const attributeOverrides = extractAttributeOverrides(message);

    return {
      intent,
      mode,
      scene,
      style,
      lighting,
      composition,
      camera,
      colorDirection,
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
