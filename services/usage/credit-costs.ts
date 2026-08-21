/**
 * Credit cost table — the single place a billable operation's cost is
 * computed. Pure, no I/O, so it's trivially unit-testable and reusable
 * from both the request-side (checking/reserving before a job exists)
 * and any future display code (showing a cost estimate in the UI).
 *
 * See docs/usage.md "Credit cost rule" for the documented policy this
 * implements.
 */
import type { UsageOperationType } from "@prisma/client";
import type { GenerationMode } from "../ai/types";

/**
 * Per-OUTPUT cost, before multiplying by output count. Editing
 * (IMAGE_TO_IMAGE/IMAGE_EDIT/VARIATION) costs more than a fresh
 * TEXT_TO_IMAGE generation — a genuinely more expensive class of request
 * against most real image-editing models, which is the whole reason this
 * is broken out by mode rather than one flat per-operation number.
 */
const PER_OUTPUT_COST: Record<UsageOperationType, number | Partial<Record<GenerationMode, number>>> = {
  PRODUCT_ANALYSIS: 1,
  IMAGE_GENERATION: {
    TEXT_TO_IMAGE: 2,
    IMAGE_TO_IMAGE: 3,
    IMAGE_EDIT: 3,
    VARIATION: 2,
  },
  IMAGE_PROCESSING: 1,
  STORE_VISUAL_GENERATION: 2,
};

/** The fallback per-output cost for IMAGE_GENERATION when no mode is
 * given (every pre-existing, non-Creative-Studio generationType never
 * sets `mode` — see services/ai/types.ts's `GenerateImageInput.mode` doc
 * comment) — priced the same as a fresh TEXT_TO_IMAGE request. */
const DEFAULT_IMAGE_GENERATION_MODE_COST = 2;

export interface CreditCostInput {
  operationType: UsageOperationType;
  /** IMAGE_GENERATION only — which generation mode this request is (see
   * services/ai/types.ts). Ignored for every other operationType. */
  mode?: GenerationMode;
  /** How many outputs this one logical operation produces. Defaults to 1
   * — PRODUCT_ANALYSIS has no "outputCount" concept and always costs its
   * flat per-operation rate regardless of what's passed here. */
  outputCount?: number;
}

/**
 * `perOutputCost(operationType, mode) × max(1, outputCount)` — the
 * documented, single credit-cost rule (see docs/usage.md). A multi
 * -output generation ("give me 3 variations") is ONE logical operation —
 * one GenerationJob, one CreditReservation row — charged for every
 * output it actually requests, not per-result after the fact (the
 * reservation is made against the REQUESTED output count before the job
 * even runs; see services/usage/entitlement.server.ts).
 */
export function getCreditCost(input: CreditCostInput): number {
  const table = PER_OUTPUT_COST[input.operationType];
  const perOutput =
    input.operationType === "PRODUCT_ANALYSIS"
      ? (table as number)
      : typeof table === "number"
        ? table
        : (input.mode ? table[input.mode] : undefined) ?? DEFAULT_IMAGE_GENERATION_MODE_COST;

  if (input.operationType === "PRODUCT_ANALYSIS") return perOutput;

  const outputCount = Math.max(1, input.outputCount ?? 1);
  return perOutput * outputCount;
}
