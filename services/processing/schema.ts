/**
 * Structured, validated shapes for the processing domain — mirrors
 * services/generation/schema.ts's "reject malformed input/output, never
 * silently accept it" philosophy.
 */
import { z } from "zod";
import { IMAGE_OPERATIONS, ASPECT_RATIO_PRESETS } from "./types";

export const ImageOperationSchema = z.enum(IMAGE_OPERATIONS);
export const AspectRatioPresetSchema = z.enum(ASPECT_RATIO_PRESETS);

/**
 * Operation-specific options. Deliberately one loose-but-validated shape
 * rather than a discriminated union per operation — every field is
 * optional and only `RESIZE` currently reads `aspectRatio` (see
 * services/processing/build-input.ts); this keeps `ProcessingJob.options`
 * simple to persist/read while still rejecting an unrecognized key.
 */
export const ProcessingOptionsSchema = z
  .object({
    aspectRatio: AspectRatioPresetSchema.optional(),
  })
  .strict();

export type ProcessingOptions = z.infer<typeof ProcessingOptionsSchema>;

export class InvalidProcessingOptionsError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid processing options: ${issues.join("; ")}`);
    this.name = "InvalidProcessingOptionsError";
    this.issues = issues;
  }
}

export function parseProcessingOptions(raw: unknown): ProcessingOptions {
  const result = ProcessingOptionsSchema.safeParse(raw ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new InvalidProcessingOptionsError(issues);
  }
  return result.data;
}

/**
 * Light validation of a provider's raw `ImageProcessingOutput` —
 * deliberately not a full Zod schema (image bytes aren't meaningfully
 * schema-validated the way JSON is), just the checks that catch a
 * provider returning something categorically unusable. See CLAUDE.md
 * "Reject malformed provider output" applied to this domain.
 */
export class InvalidProcessingOutputError extends Error {
  constructor(reason: string) {
    super(`Provider returned an invalid processing result: ${reason}`);
    this.name = "InvalidProcessingOutputError";
  }
}

export function assertValidProcessingOutput(output: { data: Uint8Array; contentType: string }): void {
  if (!(output.data instanceof Uint8Array) || output.data.byteLength === 0) {
    throw new InvalidProcessingOutputError("output has no image data");
  }
  if (!output.contentType || typeof output.contentType !== "string") {
    throw new InvalidProcessingOutputError("output is missing a contentType");
  }
}
