/**
 * Integration tests: services/generation/brand-style-preset.server.ts —
 * built-in + custom preset resolution/listing/creation against a real
 * local Postgres.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../../db/client.server";
import {
  listAvailablePresets,
  resolveBrandStylePreset,
  createCustomPreset,
  updateCustomPreset,
  deleteCustomPreset,
  getDefaultPresetId,
  setDefaultPresetId,
  InvalidPresetNameError,
  DuplicatePresetNameError,
  PresetNotFoundError,
  BuiltInPresetImmutableError,
} from "../../../services/generation/brand-style-preset.server";
import { InvalidBrandStylePresetError } from "../../../services/generation/schema";
import type { AuthContext } from "../../../lib/auth/types";

const SHOP_A = "preset-service-test-a.myshopify.com";
const SHOP_B = "preset-service-test-b.myshopify.com";
const CONTEXT_A: AuthContext = { shop: SHOP_A, sessionId: "s1", isOnline: false };
const CONTEXT_B: AuthContext = { shop: SHOP_B, sessionId: "s1", isOnline: false };

async function cleanup() {
  await prisma.brandStylePreset.deleteMany({ where: { shop: { in: [SHOP_A, SHOP_B] } } });
  await prisma.shopSettings.deleteMany({ where: { shop: { in: [SHOP_A, SHOP_B] } } });
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("listAvailablePresets", () => {
  it("includes all 6 built-ins even for a shop with no custom presets", async () => {
    const list = await listAvailablePresets(CONTEXT_A);
    expect(list.filter((p) => !p.isCustom)).toHaveLength(6);
    expect(list.every((p) => !p.isCustom)).toBe(true);
  });

  it("includes a shop's own custom presets alongside the built-ins, but never another shop's", async () => {
    await createCustomPreset(CONTEXT_A, { name: "Shop A Look", attributes: { mood: "cozy" } });
    await createCustomPreset(CONTEXT_B, { name: "Shop B Look", attributes: { mood: "bold" } });

    const listA = await listAvailablePresets(CONTEXT_A);
    expect(listA.filter((p) => p.isCustom).map((p) => p.name)).toEqual(["Shop A Look"]);
  });
});

describe("resolveBrandStylePreset", () => {
  it("resolves a built-in preset id without any DB lookup", async () => {
    const resolved = await resolveBrandStylePreset(CONTEXT_A, "minimal-studio");
    expect(resolved?.name).toBe("Minimal Studio");
  });

  it("resolves a shop's own custom preset id", async () => {
    const created = await createCustomPreset(CONTEXT_A, { name: "Custom Look", attributes: { mood: "cozy" } });
    const resolved = await resolveBrandStylePreset(CONTEXT_A, created.id);
    expect(resolved?.name).toBe("Custom Look");
  });

  it("returns null (never throws) for an unknown id", async () => {
    expect(await resolveBrandStylePreset(CONTEXT_A, "does-not-exist")).toBeNull();
  });

  it("returns null (never leaks another shop's preset) for a cross-shop custom preset id", async () => {
    const createdB = await createCustomPreset(CONTEXT_B, { name: "Shop B Only", attributes: { mood: "bold" } });
    expect(await resolveBrandStylePreset(CONTEXT_A, createdB.id)).toBeNull();
  });
});

describe("createCustomPreset", () => {
  it("validates attributes against BrandStylePresetAttributesSchema", async () => {
    await expect(
      createCustomPreset(CONTEXT_A, { name: "Bad Preset", attributes: { mood: 123 } }),
    ).rejects.toThrow(InvalidBrandStylePresetError);
  });

  it("rejects an empty name", async () => {
    await expect(createCustomPreset(CONTEXT_A, { name: "  ", attributes: {} })).rejects.toThrow(InvalidPresetNameError);
  });

  it("rejects a name that collides with a built-in preset's name (case-insensitively)", async () => {
    await expect(createCustomPreset(CONTEXT_A, { name: "minimal studio", attributes: {} })).rejects.toThrow(
      InvalidPresetNameError,
    );
  });

  it("rejects a duplicate custom preset name for the same shop", async () => {
    await createCustomPreset(CONTEXT_A, { name: "My Look", attributes: {} });
    await expect(createCustomPreset(CONTEXT_A, { name: "My Look", attributes: {} })).rejects.toThrow(
      DuplicatePresetNameError,
    );
  });
});

describe("updateCustomPreset", () => {
  it("updates a shop's own custom preset", async () => {
    const created = await createCustomPreset(CONTEXT_A, { name: "Original", attributes: { mood: "cozy" } });
    await updateCustomPreset(CONTEXT_A, created.id, { name: "Renamed", attributes: { mood: "bright" } });

    const resolved = await resolveBrandStylePreset(CONTEXT_A, created.id);
    expect(resolved?.name).toBe("Renamed");
    expect(resolved?.attributes).toEqual({ mood: "bright" });
  });

  it("throws BuiltInPresetImmutableError for a built-in preset id", async () => {
    await expect(updateCustomPreset(CONTEXT_A, "minimal-studio", { name: "Hijacked" })).rejects.toThrow(
      BuiltInPresetImmutableError,
    );
  });

  it("throws PresetNotFoundError for another shop's preset (never leaks that it exists)", async () => {
    const createdB = await createCustomPreset(CONTEXT_B, { name: "Shop B Look", attributes: {} });
    await expect(updateCustomPreset(CONTEXT_A, createdB.id, { name: "Hijacked" })).rejects.toThrow(PresetNotFoundError);
  });

  it("throws PresetNotFoundError for a nonexistent id", async () => {
    await expect(updateCustomPreset(CONTEXT_A, "does-not-exist", { name: "X" })).rejects.toThrow(PresetNotFoundError);
  });

  it("rejects a rename that collides with a built-in preset name", async () => {
    const created = await createCustomPreset(CONTEXT_A, { name: "Original", attributes: {} });
    await expect(updateCustomPreset(CONTEXT_A, created.id, { name: "Luxury Editorial" })).rejects.toThrow(InvalidPresetNameError);
  });

  it("validates updated attributes", async () => {
    const created = await createCustomPreset(CONTEXT_A, { name: "Original", attributes: {} });
    await expect(updateCustomPreset(CONTEXT_A, created.id, { attributes: { mood: 123 } })).rejects.toThrow(
      InvalidBrandStylePresetError,
    );
  });
});

describe("deleteCustomPreset", () => {
  it("deletes a shop's own custom preset", async () => {
    const created = await createCustomPreset(CONTEXT_A, { name: "To Delete", attributes: {} });
    await deleteCustomPreset(CONTEXT_A, created.id);
    expect(await resolveBrandStylePreset(CONTEXT_A, created.id)).toBeNull();
  });

  it("throws BuiltInPresetImmutableError for a built-in preset id", async () => {
    await expect(deleteCustomPreset(CONTEXT_A, "minimal-studio")).rejects.toThrow(BuiltInPresetImmutableError);
  });

  it("throws PresetNotFoundError for another shop's preset (and does not delete it)", async () => {
    const createdB = await createCustomPreset(CONTEXT_B, { name: "Shop B Look", attributes: {} });
    await expect(deleteCustomPreset(CONTEXT_A, createdB.id)).rejects.toThrow(PresetNotFoundError);
    expect(await resolveBrandStylePreset(CONTEXT_B, createdB.id)).not.toBeNull();
  });

  it("throws PresetNotFoundError for a nonexistent id", async () => {
    await expect(deleteCustomPreset(CONTEXT_A, "does-not-exist")).rejects.toThrow(PresetNotFoundError);
  });
});

describe("getDefaultPresetId / setDefaultPresetId", () => {
  it("has no default preset for a shop that never set one", async () => {
    expect(await getDefaultPresetId(CONTEXT_A)).toBeNull();
  });

  it("sets and reads back a default preset id, scoped per shop", async () => {
    await setDefaultPresetId(CONTEXT_A, "minimal-studio");
    expect(await getDefaultPresetId(CONTEXT_A)).toBe("minimal-studio");
    expect(await getDefaultPresetId(CONTEXT_B)).toBeNull();
  });

  it("clears a default preset when set to null", async () => {
    await setDefaultPresetId(CONTEXT_A, "minimal-studio");
    await setDefaultPresetId(CONTEXT_A, null);
    expect(await getDefaultPresetId(CONTEXT_A)).toBeNull();
  });

  it("does not validate that the id resolves to a real preset — degrades gracefully", async () => {
    await setDefaultPresetId(CONTEXT_A, "does-not-exist-anymore");
    expect(await getDefaultPresetId(CONTEXT_A)).toBe("does-not-exist-anymore");
    expect(await resolveBrandStylePreset(CONTEXT_A, "does-not-exist-anymore")).toBeNull();
  });
});
