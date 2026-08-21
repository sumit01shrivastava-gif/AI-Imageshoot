/**
 * Repository for `ShopSettings` — one row per shop, created lazily on
 * first write. Currently just the default brand style preset — see
 * prisma/schema.prisma's model comment and
 * services/generation/brand-style-preset.server.ts.
 */
import prisma from "../client.server";

export interface ShopSettingsRow {
  shop: string;
  defaultBrandStylePresetId: string | null;
}

/** Returns `null` (not a default row) rather than creating one — a shop
 * with no settings yet simply has no default preset, which every caller
 * already treats as "no preset chosen" (the same state as an omitted
 * presetId elsewhere in this domain). */
export async function getShopSettings(shop: string): Promise<ShopSettingsRow | null> {
  return prisma.shopSettings.findUnique({ where: { shop }, select: { shop: true, defaultBrandStylePresetId: true } });
}

/** Upserts the shop's default preset id — `null` clears it. Never
 * validates that `presetId` actually resolves to a real preset (built-in
 * or custom); the read side (resolveBrandStylePreset) already treats an
 * unknown id as "no preset" safely, so a stale default (e.g. a deleted
 * custom preset) degrades gracefully rather than needing to be kept in
 * lockstep here. */
export async function setDefaultBrandStylePreset(shop: string, presetId: string | null): Promise<void> {
  await prisma.shopSettings.upsert({
    where: { shop },
    create: { shop, defaultBrandStylePresetId: presetId },
    update: { defaultBrandStylePresetId: presetId },
  });
}
