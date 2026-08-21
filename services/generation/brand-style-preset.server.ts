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
  updateBrandStylePreset as updateBrandStylePresetRow,
  deleteBrandStylePreset as deleteBrandStylePresetRow,
  listBrandStylePresetsForShop,
  DuplicatePresetNameError,
} from "../../db/repositories/brand-style-preset.repository";
import { getShopSettings, setDefaultBrandStylePreset as setDefaultBrandStylePresetRow } from "../../db/repositories/shop-settings.repository";
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

export class PresetNotFoundError extends Error {
  constructor() {
    super("Preset not found.");
    this.name = "PresetNotFoundError";
  }
}

export class BuiltInPresetImmutableError extends Error {
  constructor() {
    super("Built-in presets can't be edited or deleted.");
    this.name = "BuiltInPresetImmutableError";
  }
}

export interface UpdateCustomPresetInput {
  name?: string;
  description?: string | null;
  attributes?: unknown;
}

/** Updates a shop-owned custom preset. Throws `BuiltInPresetImmutableError`
 * for any of the 6 built-in ids (they're code constants, not rows — see
 * ./brand-style-presets), `PresetNotFoundError` for a missing or
 * cross-shop id (the repository's `TenantMismatchError` is mapped to the
 * same not-found result a merchant would see for a nonexistent preset,
 * never distinguishing the two), and `InvalidPresetNameError`/
 * `InvalidBrandStylePresetError` for bad input — the same validation
 * `createCustomPreset` applies. */
export async function updateCustomPreset(context: AuthContext, id: string, input: UpdateCustomPresetInput): Promise<{ id: string }> {
  if (isBuiltInPresetId(id)) {
    throw new BuiltInPresetImmutableError();
  }

  let name: string | undefined;
  if (input.name !== undefined) {
    name = input.name.trim();
    if (name.length === 0) {
      throw new InvalidPresetNameError("Preset name is required.");
    }
    if (BRAND_STYLE_PRESETS.some((preset) => preset.name.toLowerCase() === name!.toLowerCase())) {
      throw new InvalidPresetNameError(`"${name}" is a built-in preset name and can't be reused.`);
    }
  }

  const attributes = input.attributes !== undefined ? parseBrandStylePresetAttributes(input.attributes) : undefined;

  try {
    const row = await updateBrandStylePresetRow(context, id, { name, description: input.description, attributes });
    if (!row) throw new PresetNotFoundError();
    return { id: row.id };
  } catch (error) {
    if (error instanceof TenantMismatchError) throw new PresetNotFoundError();
    throw error;
  }
}

/** Permanently deletes a shop-owned custom preset. Throws
 * `BuiltInPresetImmutableError` for a built-in id, `PresetNotFoundError`
 * for a missing or cross-shop id. See
 * db/repositories/brand-style-preset.repository.ts's `deleteBrandStylePreset`
 * doc comment for why this is a safe hard delete (past generation plans
 * already snapshotted the resolved attributes; nothing else references
 * this row live). */
export async function deleteCustomPreset(context: AuthContext, id: string): Promise<void> {
  if (isBuiltInPresetId(id)) {
    throw new BuiltInPresetImmutableError();
  }
  let deleted: boolean;
  try {
    deleted = await deleteBrandStylePresetRow(context, id);
  } catch (error) {
    if (error instanceof TenantMismatchError) throw new PresetNotFoundError();
    throw error;
  }
  if (!deleted) throw new PresetNotFoundError();
}

/** The shop's default preset id, or `null` if none is set. Never
 * validated against the built-in/custom catalog on read — a stale
 * default (e.g. pointing at a since-deleted custom preset) is the read
 * side's concern (`resolveBrandStylePreset` already returns `null` for
 * an unresolvable id, treated the same as "no preset chosen" everywhere
 * this is consumed). */
export async function getDefaultPresetId(context: AuthContext): Promise<string | null> {
  const settings = await getShopSettings(context.shop);
  return settings?.defaultBrandStylePresetId ?? null;
}

/** Sets (or, with `id: null`, clears) the shop's default preset. Does not
 * require `id` to resolve to a real preset — see
 * `setDefaultBrandStylePreset`'s repository-level doc comment for why
 * that's intentional. */
export async function setDefaultPresetId(context: AuthContext, id: string | null): Promise<void> {
  await setDefaultBrandStylePresetRow(context.shop, id);
}
