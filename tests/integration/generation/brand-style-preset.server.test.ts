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
  InvalidPresetNameError,
  DuplicatePresetNameError,
} from "../../../services/generation/brand-style-preset.server";
import { InvalidBrandStylePresetError } from "../../../services/generation/schema";
import type { AuthContext } from "../../../lib/auth/types";

const SHOP_A = "preset-service-test-a.myshopify.com";
const SHOP_B = "preset-service-test-b.myshopify.com";
const CONTEXT_A: AuthContext = { shop: SHOP_A, sessionId: "s1", isOnline: false };
const CONTEXT_B: AuthContext = { shop: SHOP_B, sessionId: "s1", isOnline: false };

async function cleanup() {
  await prisma.brandStylePreset.deleteMany({ where: { shop: { in: [SHOP_A, SHOP_B] } } });
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
