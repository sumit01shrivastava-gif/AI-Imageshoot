/**
 * Integration tests: db/repositories/brand-style-preset.repository.ts —
 * shop-scoped CRUD for CUSTOM presets only (built-ins are code constants,
 * see services/generation/brand-style-presets.ts and its own unit tests)
 * against a real local Postgres.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../../db/client.server";
import {
  createBrandStylePreset,
  listBrandStylePresetsForShop,
  getBrandStylePreset,
  DuplicatePresetNameError,
} from "../../../db/repositories/brand-style-preset.repository";
import { TenantMismatchError } from "../../../lib/auth/tenant.server";
import type { AuthContext } from "../../../lib/auth/types";
import type { BrandStylePresetAttributes } from "../../../services/generation/schema";

const SHOP_A = "preset-repo-test-a.myshopify.com";
const SHOP_B = "preset-repo-test-b.myshopify.com";
const CONTEXT_A: AuthContext = { shop: SHOP_A, sessionId: "s1", isOnline: false };

const ATTRS: BrandStylePresetAttributes = {
  visualTone: "bright and airy",
  environment: "sunlit kitchen counter",
  mood: "cozy",
};

async function cleanup() {
  await prisma.brandStylePreset.deleteMany({ where: { shop: { in: [SHOP_A, SHOP_B] } } });
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("createBrandStylePreset / listBrandStylePresetsForShop", () => {
  it("creates a custom preset and lists it back for its own shop", async () => {
    await createBrandStylePreset({ shop: SHOP_A, name: "My Custom Look", description: "For candles", attributes: ATTRS });

    const list = await listBrandStylePresetsForShop(CONTEXT_A);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("My Custom Look");
    expect(list[0].attributes).toEqual(ATTRS);
  });

  it("never lists another shop's presets", async () => {
    await createBrandStylePreset({ shop: SHOP_B, name: "Shop B's Preset", attributes: ATTRS });
    expect(await listBrandStylePresetsForShop(CONTEXT_A)).toHaveLength(0);
  });

  it("throws DuplicatePresetNameError for a second preset with the same name in the same shop", async () => {
    await createBrandStylePreset({ shop: SHOP_A, name: "Repeated Name", attributes: ATTRS });
    await expect(createBrandStylePreset({ shop: SHOP_A, name: "Repeated Name", attributes: ATTRS })).rejects.toThrow(
      DuplicatePresetNameError,
    );
  });

  it("allows the same preset name to be reused across different shops", async () => {
    await createBrandStylePreset({ shop: SHOP_A, name: "Shared Name", attributes: ATTRS });
    await expect(createBrandStylePreset({ shop: SHOP_B, name: "Shared Name", attributes: ATTRS })).resolves.not.toThrow();
  });
});

describe("getBrandStylePreset", () => {
  it("loads one preset by id, shop-scoped", async () => {
    const created = await createBrandStylePreset({ shop: SHOP_A, name: "Look", attributes: ATTRS });
    const loaded = await getBrandStylePreset(CONTEXT_A, created.id);
    expect(loaded?.name).toBe("Look");
  });

  it("throws TenantMismatchError for another shop's preset", async () => {
    const createdB = await createBrandStylePreset({ shop: SHOP_B, name: "Shop B Look", attributes: ATTRS });
    await expect(getBrandStylePreset(CONTEXT_A, createdB.id)).rejects.toThrow(TenantMismatchError);
  });

  it("returns null for a preset id that doesn't exist (including a built-in preset's own id, which is never a row here)", async () => {
    expect(await getBrandStylePreset(CONTEXT_A, "minimal-studio")).toBeNull();
    expect(await getBrandStylePreset(CONTEXT_A, "does-not-exist")).toBeNull();
  });
});
