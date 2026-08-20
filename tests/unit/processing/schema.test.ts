import { describe, expect, it } from "vitest";
import {
  parseProcessingOptions,
  InvalidProcessingOptionsError,
  assertValidProcessingOutput,
  InvalidProcessingOutputError,
} from "../../../services/processing/schema";

describe("parseProcessingOptions", () => {
  it("accepts an empty/undefined options value (most operations take none)", () => {
    expect(parseProcessingOptions(undefined)).toEqual({});
    expect(parseProcessingOptions({})).toEqual({});
  });

  it("accepts a valid aspectRatio preset", () => {
    expect(parseProcessingOptions({ aspectRatio: "4:5" })).toEqual({ aspectRatio: "4:5" });
  });

  it("rejects an unknown aspectRatio value", () => {
    expect(() => parseProcessingOptions({ aspectRatio: "21:9" })).toThrow(InvalidProcessingOptionsError);
  });

  it("rejects an unrecognized option key (strict schema)", () => {
    expect(() => parseProcessingOptions({ somethingElse: true })).toThrow(InvalidProcessingOptionsError);
  });
});

describe("assertValidProcessingOutput", () => {
  it("accepts a well-formed output", () => {
    expect(() =>
      assertValidProcessingOutput({ data: new Uint8Array([1, 2, 3]), contentType: "image/png" }),
    ).not.toThrow();
  });

  it("rejects empty image data", () => {
    expect(() => assertValidProcessingOutput({ data: new Uint8Array([]), contentType: "image/png" })).toThrow(
      InvalidProcessingOutputError,
    );
  });

  it("rejects a missing contentType", () => {
    expect(() => assertValidProcessingOutput({ data: new Uint8Array([1]), contentType: "" })).toThrow(
      InvalidProcessingOutputError,
    );
  });
});
