/**
 * OpenAI Chat Completions `response_format: { type: "json_schema", ... }`
 * ("Structured Outputs") wire schema for the intent-parsing call —
 * quality-floor pass, second round.
 *
 * The forensic diagnosis found `openai-intent-parser.server.ts` used
 * basic `response_format: { type: "json_object" }`, which guarantees
 * only "the response is valid JSON," not that any particular field is
 * present. Structured Outputs' `strict: true` mode additionally
 * guarantees every field in this schema's `required` arrays is present
 * with the declared type — closing the class of failure where a model
 * silently omits an optional-shaped field (e.g. `creativeConcept`) even
 * when the system instruction asks for it.
 *
 * This mirrors `services/creative-studio/intent-schema.ts`'s
 * `ParsedIntentSchema` field-for-field, duplicated here (never imported)
 * for the same reason `creative-director-instructions.ts` already
 * duplicates the enum value lists as plain text: `services/ai/` must
 * stay domain-agnostic and never import a higher domain layer's
 * concrete type (CLAUDE.md's architecture principles). If
 * `ParsedIntentSchema` changes, this file must be kept in sync — a
 * drift here only degrades quality (a field the wire schema no longer
 * matches falls back to whatever the model does anyway), since
 * `parseParsedIntent` still independently validates and rejects
 * malformed output regardless (CLAUDE.md "Reject malformed provider
 * output") — this is a stricter co-pilot for that validation, never a
 * replacement for it.
 *
 * Presence guarantees intact here do NOT guarantee semantic quality — a
 * model could still emit `"creativeConcept": "energetic red
 * environment"` and satisfy this schema perfectly. That is exactly why
 * `services/creative-studio/creative-brief.ts`'s Campaign Concept
 * Contract validation (`hasSubstantiveCampaignConcept`) exists as a
 * SEPARATE, deterministic layer this schema does not and cannot replace.
 *
 * Deliberately omits `strict`-incompatible Zod refinements
 * (`min(1)`/`max(N)` length bounds, `min`/`max` numeric bounds) — the
 * documented, supported Structured Outputs subset does not include
 * string/array length constraints; the Zod schema this call's output
 * still passes through afterward enforces those exactly as before, so
 * nothing is weakened by their absence here.
 */

const NULLABLE_STRING = { type: ["string", "null"] } as const;

const CREATIVE_INTENT_VALUES = [
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

const GENERATION_MODE_VALUES = ["TEXT_TO_IMAGE", "IMAGE_TO_IMAGE", "IMAGE_EDIT", "VARIATION"] as const;

const campaignCommunicationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: { type: "string", enum: ["VISUAL_ONLY", "MINIMAL_CAMPAIGN_COPY", "FACTUAL_CALLOUTS"] },
    headline: NULLABLE_STRING,
    supportingLine: NULLABLE_STRING,
    callouts: { type: "array", items: { type: "string" } },
    provenance: { type: "string", enum: ["NONE", "EVOCATIVE", "USER_EXPLICIT", "TRUSTED_CATALOG"] },
    reservedTextArea: {
      type: "string",
      enum: ["NONE", "TOP_LEFT", "TOP_RIGHT", "TOP_CENTER", "BOTTOM_LEFT", "BOTTOM_RIGHT", "BOTTOM_CENTER", "SIDE"],
    },
  },
  required: ["mode", "headline", "supportingLine", "callouts", "provenance", "reservedTextArea"],
} as const;

// Mirrors intent-schema.ts's CampaignArtDirectionSchema, including the
// Campaign Concept Contract fields (visualMechanism/productRole/
// scrollStopDevice) added in this pass — see that schema's own doc
// comment for what each field means.
const campaignArtDirectionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    visualStory: NULLABLE_STRING,
    heroTreatment: NULLABLE_STRING,
    canvasArchitecture: NULLABLE_STRING,
    productEnvironmentRelationship: NULLABLE_STRING,
    materialLightingStrategy: NULLABLE_STRING,
    visualMechanism: NULLABLE_STRING,
    productRole: NULLABLE_STRING,
    scrollStopDevice: NULLABLE_STRING,
  },
  required: [
    "visualStory",
    "heroTreatment",
    "canvasArchitecture",
    "productEnvironmentRelationship",
    "materialLightingStrategy",
    "visualMechanism",
    "productRole",
    "scrollStopDevice",
  ],
} as const;

const attributeOverridesSchema = {
  type: "object",
  additionalProperties: false,
  properties: { color: NULLABLE_STRING, material: NULLABLE_STRING },
  required: ["color", "material"],
} as const;

/** The full `response_format` value ready to place directly on a Chat
 * Completions request body — see `openai-intent-parser.server.ts`. */
export const PARSED_INTENT_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "parsed_creative_intent",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        intent: { type: "string", enum: CREATIVE_INTENT_VALUES },
        mode: { type: "string", enum: GENERATION_MODE_VALUES },
        subject: NULLABLE_STRING,
        action: NULLABLE_STRING,
        scene: NULLABLE_STRING,
        style: { type: "array", items: { type: "string" } },
        lighting: NULLABLE_STRING,
        composition: NULLABLE_STRING,
        camera: NULLABLE_STRING,
        colorDirection: NULLABLE_STRING,
        depthOfField: NULLABLE_STRING,
        addElements: { type: "array", items: { type: "string" } },
        removeElements: { type: "array", items: { type: "string" } },
        variationCount: { type: "integer" },
        targetResultReference: NULLABLE_STRING,
        preserveHints: { type: "array", items: { type: "string" } },
        attributeOverrides: attributeOverridesSchema,
        changeSummary: { type: "string" },
        confidence: { type: "number" },
        overallCreativeDirection: NULLABLE_STRING,
        inferredCreativeDecisions: { type: "array", items: { type: "string" } },
        creativeConcept: NULLABLE_STRING,
        negativeCreativeDecisions: { type: "array", items: { type: "string" } },
        campaignCommunication: campaignCommunicationSchema,
        campaignArtDirection: campaignArtDirectionSchema,
      },
      required: [
        "intent",
        "mode",
        "subject",
        "action",
        "scene",
        "style",
        "lighting",
        "composition",
        "camera",
        "colorDirection",
        "depthOfField",
        "addElements",
        "removeElements",
        "variationCount",
        "targetResultReference",
        "preserveHints",
        "attributeOverrides",
        "changeSummary",
        "confidence",
        "overallCreativeDirection",
        "inferredCreativeDecisions",
        "creativeConcept",
        "negativeCreativeDecisions",
        "campaignCommunication",
        "campaignArtDirection",
      ],
    },
  },
} as const;
