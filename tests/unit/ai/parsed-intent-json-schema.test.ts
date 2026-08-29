/**
 * Unit tests: services/ai/parsed-intent-json-schema.ts —
 * `PARSED_INTENT_RESPONSE_FORMAT`, the OpenAI Structured Outputs wire
 * schema for the real intent-parsing call (quality-floor pass, second
 * round). Never calls a real API — verifies the schema OBJECT ITSELF
 * satisfies OpenAI's documented `strict: true` invariants structurally,
 * which is the confidence this migration needs without a live request:
 * a schema violating these rules is rejected by OpenAI's API with a 400
 * before the model ever runs, so getting this right matters as much as
 * the parsing logic itself.
 */
import { describe, expect, it } from "vitest";
import { PARSED_INTENT_RESPONSE_FORMAT } from "../../../services/ai/parsed-intent-json-schema";

interface JsonSchemaObject {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  items?: unknown;
}

function isSchemaObject(value: unknown): value is JsonSchemaObject {
  return typeof value === "object" && value !== null && "type" in value;
}

/** Recursively walks every nested object schema and asserts OpenAI's
 * strict-mode rules: `additionalProperties: false`, and every key in
 * `properties` also appears in `required` (strict mode has no concept of
 * an optional property — "optional" must be expressed as nullable). */
function assertStrictObjectInvariants(schema: unknown, path: string) {
  if (!isSchemaObject(schema)) return;
  if (schema.type === "object") {
    expect(schema.additionalProperties, `${path}: additionalProperties must be false`).toBe(false);
    const propertyNames = Object.keys(schema.properties ?? {});
    expect(schema.required, `${path}: required must be an array`).toBeDefined();
    for (const name of propertyNames) {
      expect(schema.required, `${path}.${name} must be listed in required (strict mode has no optional properties)`).toContain(name);
    }
    expect(propertyNames.length, `${path}: required must not list an unknown property`).toBe(schema.required!.length);
    for (const [name, value] of Object.entries(schema.properties ?? {})) {
      assertStrictObjectInvariants(value, `${path}.${name}`);
    }
  }
  if (schema.type === "array" && schema.items) {
    assertStrictObjectInvariants(schema.items, `${path}[]`);
  }
}

describe("PARSED_INTENT_RESPONSE_FORMAT", () => {
  it("uses OpenAI's Structured Outputs json_schema mode with strict enforcement", () => {
    expect(PARSED_INTENT_RESPONSE_FORMAT.type).toBe("json_schema");
    expect(PARSED_INTENT_RESPONSE_FORMAT.json_schema.strict).toBe(true);
    expect(PARSED_INTENT_RESPONSE_FORMAT.json_schema.name).toBeTruthy();
  });

  it("satisfies OpenAI's strict-mode invariants at every nesting level (additionalProperties:false, every property required)", () => {
    assertStrictObjectInvariants(PARSED_INTENT_RESPONSE_FORMAT.json_schema.schema, "root");
  });

  it("mirrors ParsedIntentSchema's full field set at the top level", () => {
    const properties = PARSED_INTENT_RESPONSE_FORMAT.json_schema.schema.properties;
    for (const field of [
      "intent", "mode", "subject", "action", "scene", "style", "lighting", "composition", "camera", "colorDirection",
      "depthOfField", "addElements", "removeElements", "variationCount", "targetResultReference", "preserveHints",
      "attributeOverrides", "changeSummary", "confidence", "overallCreativeDirection", "inferredCreativeDecisions",
      "creativeConcept", "negativeCreativeDecisions", "campaignCommunication", "campaignArtDirection",
    ]) {
      expect(properties, `missing field: ${field}`).toHaveProperty(field);
    }
  });

  it("includes the Campaign Concept Contract fields (visualMechanism/productRole/scrollStopDevice) in campaignArtDirection, required and nullable", () => {
    const art = PARSED_INTENT_RESPONSE_FORMAT.json_schema.schema.properties.campaignArtDirection;
    for (const field of ["visualMechanism", "productRole", "scrollStopDevice"]) {
      expect(art.properties, `missing field: ${field}`).toHaveProperty(field);
      expect(art.required).toContain(field);
      const fieldSchema = (art.properties as Record<string, { type: readonly string[] }>)[field];
      expect(fieldSchema.type).toEqual(["string", "null"]);
    }
  });

  it("declares intent/mode as real enums matching the current taxonomy", () => {
    const properties = PARSED_INTENT_RESPONSE_FORMAT.json_schema.schema.properties;
    expect(properties.intent.enum).toContain("CREATE_SOCIAL");
    expect(properties.intent.enum).toContain("CREATE_BANNER");
    expect(properties.mode.enum).toEqual(["TEXT_TO_IMAGE", "IMAGE_TO_IMAGE", "IMAGE_EDIT", "VARIATION"]);
  });

  it("is JSON-serializable (a real sanity check the wire body will actually encode)", () => {
    expect(() => JSON.stringify(PARSED_INTENT_RESPONSE_FORMAT)).not.toThrow();
  });
});
