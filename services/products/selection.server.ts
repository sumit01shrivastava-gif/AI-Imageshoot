/**
 * Source-image selection — the business-rule layer on top of
 * db/repositories/image-selection.repository.ts (which owns the actual
 * shop-ownership/consistency validation and persistence).
 *
 * This is deliberately NOT a `GenerationJob`: it has no "operation" or
 * "generation configuration" field, because no operation has been chosen
 * yet at this point in the flow. It exists so the "Continue" action has a
 * concrete, server-validated request to hand to a future phase instead of
 * only ever having lived in browser state — see prisma/schema.prisma's
 * `ImageSelection` model comment and docs/database.md.
 */
import type { AuthContext } from "../../lib/auth/types";
import {
  createSelection as createSelectionRow,
  getSelectionSummary as getSelectionSummaryRow,
  InvalidSelectionError,
} from "../../db/repositories/image-selection.repository";
import type { SelectionInput, SelectionSummary } from "./types";

export { InvalidSelectionError };

/** Defensive upper bound on one selection — not a documented product
 * limit, just a sanity guard against a malformed/abusive request. */
export const MAX_SELECTION_ITEMS = 500;

export class SelectionTooLargeError extends InvalidSelectionError {
  constructor(count: number) {
    super(`Cannot select more than ${MAX_SELECTION_ITEMS} images at once (got ${count}).`);
    this.name = "SelectionTooLargeError";
  }
}

export async function createImageSelection(
  context: AuthContext,
  items: SelectionInput[],
): Promise<string> {
  if (items.length > MAX_SELECTION_ITEMS) {
    throw new SelectionTooLargeError(items.length);
  }
  return createSelectionRow(context, items);
}

export async function getImageSelectionSummary(
  context: AuthContext,
  selectionId: string,
): Promise<SelectionSummary | null> {
  return getSelectionSummaryRow(context, selectionId);
}
