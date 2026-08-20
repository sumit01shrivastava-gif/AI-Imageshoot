/**
 * Deterministic, network-free `ImageGenerationProvider` — for tests only.
 *
 * Analogous to services/intelligence/deterministic-test-provider.server.ts:
 * a real AI vendor call can't run in an automated test (CLAUDE.md — never a
 * live provider call from a test), but the generation domain's route →
 * service → queue → provider → validation → storage → persistence → UI
 * path needs to be exercised end-to-end, not just up to the point
 * `UnconfiguredImageGenerationProvider` throws.
 *
 * Only ever selected by provider.server.ts's
 * `getConfiguredImageGenerationProvider()` when `NODE_ENV === "test"` AND
 * `AI_PROVIDER === "deterministic-test"` — both required, neither set
 * outside test config.
 *
 * Produces a fixed, tiny, valid 1x1 PNG for every output — this phase
 * never calls a real generative model, so "the generated image" is a
 * placeholder; what's real is everything around it (job lifecycle,
 * storage persistence, result rows, retry).
 */
import { createHash } from "node:crypto";
import type { GenerateImageInput, GenerateImageResult, GeneratedImageOutput, ImageGenerationProvider } from "../ai/types";

/** Smallest possible valid PNG (1x1, transparent). */
const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

/**
 * Forced-failure hooks for integration/E2E tests exercising the FAILED/
 * retry path — see docs/generation.md "Retry semantics". Checked against
 * `input.creativeDirection.negativeConstraints` (a structured, machine
 * -checkable field), never against the human-readable prompt string.
 * Reachable only by code that constructs a `GenerationPlan` directly
 * (`build-plan.ts`'s `visualDirectionOverride`) — the merchant-facing
 * route never sets this. See services/generation/build-plan.ts.
 */
export const FORCE_FAILURE_ALWAYS = "__GENERATION_TEST_FAIL_ALWAYS__";
export const FORCE_FAILURE_ONCE = "__GENERATION_TEST_FAIL_ONCE__";

function deterministicId(prefix: string, parts: string[]): string {
  const hash = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
  return `${prefix}-${hash}`;
}

export class DeterministicTestImageGenerationProvider implements ImageGenerationProvider {
  readonly name = "deterministic-test";

  async generateImage(input: GenerateImageInput): Promise<GenerateImageResult> {
    const negativeConstraints = input.creativeDirection.negativeConstraints ?? [];

    if (negativeConstraints.includes(FORCE_FAILURE_ALWAYS)) {
      throw new Error("deterministic-test provider: forced failure (every attempt)");
    }
    if (negativeConstraints.includes(FORCE_FAILURE_ONCE) && input.attempt <= 1) {
      throw new Error("deterministic-test provider: forced failure (attempt 1 only)");
    }

    const data = Buffer.from(TINY_PNG_BASE64, "base64");
    const contentType = `image/${input.outputFormat}`;

    const outputs: GeneratedImageOutput[] = Array.from({ length: input.outputCount }, (_, index) => ({
      data,
      contentType,
      width: 1,
      height: 1,
      providerResultId: deterministicId("result", [input.generationType, String(index), input.creativeDirection.prompt]),
      metadata: { source: "deterministic-test-provider", outputIndex: index, attempt: input.attempt },
    }));

    return {
      outputs,
      providerJobId: deterministicId("job", [input.generationType, input.creativeDirection.prompt, String(input.attempt)]),
      raw: { provider: "deterministic-test", generationType: input.generationType, attempt: input.attempt },
    };
  }
}
