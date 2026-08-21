/**
 * Brand style preset resolution — the merchant-facing "available presets"
 * list is built-in constants (services/generation/brand-style-presets.ts)
 * merged with a shop's own saved custom presets
 * (db/repositories/brand-style-preset.repository.ts). See
 * docs/lifestyle-generation.md "Brand style presets".
 */
import type { AuthContext } from "../../lib/auth/types";
import { TenantMismatchError } from "../../lib/auth/tenant.server";
import {
  createBrandStylePreset as createBrandStylePresetRow,
  getBrandStylePreset as getBrandStylePresetRow,
  listBrandStylePresetsForShop,
  DuplicatePresetNameError,
} from "../../db/repositories/brand-style-preset.repository";
import { BRAND_STYLE_PRESETS, getBuiltInPreset, isBuiltInPresetId, type BrandStylePresetSummary } from "./brand-style-presets";
import { parseBrandStylePresetAttributes, type BrandStylePresetAttributes } from "./schema";

export { DuplicatePresetNameError };

export class InvalidPresetNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPresetNameError";
  }
}

export interface BrandStylePresetOption extends BrandStylePresetSummary {
  /** `false` for the 6 named built-ins; `true` for a shop's own saved
   * preset — distinguishes what the UI can/can't let a merchant delete. */
  isCustom: boolean;
}

/** Every preset available to this shop: the 6 built-ins first, then the
 * shop's own custom presets, alphabetically. */
export async function listAvailablePresets(context: AuthContext): Promise<BrandStylePresetOption[]> {
  const custom = await listBrandStylePresetsForShop(context);
  return [
    ...BRAND_STYLE_PRESETS.map((preset) => ({ ...preset, isCustom: false })),
    ...custom.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description ?? "",
      attributes: row.attributes as unknown as BrandStylePresetAttributes,
      isCustom: true,
    })),
  ];
}

/**
 * Resolves one preset id to its attributes — checking the built-in
 * catalog first (no I/O), then falling back to a shop-scoped DB lookup.
 * Returns `null` if `id` is neither a known built-in nor a preset this
 * shop owns (including a cross-shop id — the repository's
 * `assertShopOwnership` throws `TenantMismatchError`, mapped here to the
 * same safe `null` a missing preset gets, so a merchant can never learn
 * whether an id belongs to another shop).
 */
export async function resolveBrandStylePreset(
  context: AuthContext,
  id: string,
): Promise<{ id: string; name: string; attributes: BrandStylePresetAttributes } | null> {
  const builtIn = getBuiltInPreset(id);
  if (builtIn) return builtIn;

  try {
    const row = await getBrandStylePresetRow(context, id);
    if (!row) return null;
    return { id: row.id, name: row.name, attributes: row.attributes as unknown as BrandStylePresetAttributes };
  } catch (error) {
    if (error instanceof TenantMismatchError) return null;
    throw error;
  }
}

export { isBuiltInPresetId };

export interface CreateCustomPresetInput {
  name: string;
  description?: string | null;
  attributes: unknown;
}

/** Creates a shop-owned custom preset. Validates `attributes` against
 * `BrandStylePresetAttributesSchema` (throws `InvalidPresetNameError`'s
 * schema-validation sibling, `InvalidBrandStylePresetError`, re-exported
 * from ./schema, on a bad shape) and rejects a name that collides with a
 * BUILT-IN preset's name (not just another custom one — the repository's
 * own `@@unique([shop, name])` only catches the latter). */
export async function createCustomPreset(context: AuthContext, input: CreateCustomPresetInput): Promise<{ id: string }> {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new InvalidPresetNameError("Preset name is required.");
  }
  if (BRAND_STYLE_PRESETS.some((preset) => preset.name.toLowerCase() === name.toLowerCase())) {
    throw new InvalidPresetNameError(`"${name}" is a built-in preset name and can't be reused.`);
  }

  const attributes = parseBrandStylePresetAttributes(input.attributes);
  return createBrandStylePresetRow({ shop: context.shop, name, description: input.description ?? null, attributes });
}
