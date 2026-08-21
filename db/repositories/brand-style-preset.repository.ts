/**
 * Repository for `BrandStylePreset` — merchant-saved CUSTOM presets only;
 * built-in presets are code constants
 * (services/generation/brand-style-presets.ts), never rows here. See
 * db/repositories/README.md and docs/lifestyle-generation.md "Brand
 * style presets".
 */
import type { Prisma } from "@prisma/client";
import prisma from "../client.server";
import type { AuthContext } from "../../lib/auth/types";
import { assertShopOwnership } from "../../lib/auth/tenant.server";
import type { BrandStylePresetAttributes } from "../../services/generation/schema";

const PRESET_SELECT = {
  id: true,
  shop: true,
  name: true,
  description: true,
  attributes: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.BrandStylePresetSelect;

export type BrandStylePresetRow = Prisma.BrandStylePresetGetPayload<{ select: typeof PRESET_SELECT }>;

export interface CreateBrandStylePresetInput {
  shop: string;
  name: string;
  description?: string | null;
  attributes: BrandStylePresetAttributes;
}

export class DuplicatePresetNameError extends Error {
  constructor(name: string) {
    super(`A preset named "${name}" already exists.`);
    this.name = "DuplicatePresetNameError";
  }
}

/** Creates a new custom preset. Throws `DuplicatePresetNameError` if this
 * shop already has a preset with the same name (`@@unique([shop, name])`
 * — see prisma/schema.prisma). */
export async function createBrandStylePreset(input: CreateBrandStylePresetInput): Promise<{ id: string }> {
  try {
    return await prisma.brandStylePreset.create({
      data: {
        shop: input.shop,
        name: input.name,
        description: input.description ?? null,
        attributes: input.attributes as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code?: string }).code === "P2002") {
      throw new DuplicatePresetNameError(input.name);
    }
    throw error;
  }
}

/** All of one shop's custom presets — never another shop's. Does not
 * include the built-in catalog (see
 * services/generation/brand-style-preset.server.ts, which merges the
 * two for a merchant-facing "available presets" list). */
export async function listBrandStylePresetsForShop(context: AuthContext): Promise<BrandStylePresetRow[]> {
  return prisma.brandStylePreset.findMany({
    where: { shop: context.shop },
    orderBy: { name: "asc" },
    select: PRESET_SELECT,
  });
}

/** Loads one custom preset, verifying shop ownership. Returns `null` if
 * not found for this shop — including when `id` is actually a built-in
 * preset id, since built-ins are never rows here (the caller checks
 * `isBuiltInPresetId` first — see
 * services/generation/brand-style-preset.server.ts). */
export async function getBrandStylePreset(context: AuthContext, id: string): Promise<BrandStylePresetRow | null> {
  const row = await prisma.brandStylePreset.findUnique({ where: { id }, select: PRESET_SELECT });
  if (!row) return null;
  assertShopOwnership(context, row.shop);
  return row;
}
