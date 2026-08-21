/**
 * Integration test for app/routes/app.presets.tsx — the route layer over
 * services/generation/brand-style-preset.server.ts's custom-preset CRUD
 * and default-preset get/set. Mirrors
 * tests/integration/routes/app.store-visuals-action.test.ts's pattern.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../../db/client.server";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";

const SHOP_A = "route-presets-a.myshopify.com";
const SHOP_B = "route-presets-b.myshopify.com";

function requestFor(shop: string): Request {
  return new Request("https://example.com/app/presets", { headers: { "x-ai-imageshoot-e2e-shop": shop } });
}

async function cleanup() {
  await prisma.brandStylePreset.deleteMany({ where: { shop: { in: [SHOP_A, SHOP_B] } } });
  await prisma.shopSettings.deleteMany({ where: { shop: { in: [SHOP_A, SHOP_B] } } });
}

let loader: typeof import("../../../app/routes/app.presets").loader;
let action: typeof import("../../../app/routes/app.presets").action;

beforeAll(async () => {
  process.env.ALLOW_E2E_AUTH_BYPASS = "1";
  resetEnvCacheForTests();
  ({ loader, action } = await import("../../../app/routes/app.presets"));
  await cleanup();
});
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function callLoader(shop: string) {
  return loader({ request: requestFor(shop), params: {}, context: {} } as unknown as Parameters<typeof loader>[0]);
}

async function callAction(shop: string, body: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(body)) formData.set(key, value);
  const request = new Request("https://example.com/app/presets", {
    method: "POST",
    headers: { "x-ai-imageshoot-e2e-shop": shop },
    body: formData,
  });
  return action({ request, params: {}, context: {} } as unknown as Parameters<typeof action>[0]);
}

describe("app.presets — loader", () => {
  it("returns the 6 built-ins and no default preset for a fresh shop", async () => {
    const result = await callLoader(SHOP_A);
    expect(result.presets.filter((p) => !p.isCustom)).toHaveLength(6);
    expect(result.defaultPresetId).toBeNull();
  });
});

describe("app.presets — create/update/delete", () => {
  it("creates a custom preset visible only to its own shop", async () => {
    const createResult = await callAction(SHOP_A, {
      intent: "create",
      name: "My Look",
      description: "For candles",
      visualTone: "warm",
    });
    expect(createResult).toEqual({ ok: true });

    const loaded = await callLoader(SHOP_A);
    const custom = loaded.presets.find((p) => p.isCustom);
    expect(custom?.name).toBe("My Look");
    expect((custom?.attributes as Record<string, unknown>).visualTone).toBe("warm");

    const otherShopLoaded = await callLoader(SHOP_B);
    expect(otherShopLoaded.presets.some((p) => p.isCustom)).toBe(false);
  });

  it("rejects an empty preset name with a merchant-safe error", async () => {
    const result = await callAction(SHOP_A, { intent: "create", name: "  " });
    expect(result).toEqual({ ok: false, error: "Preset name is required." });
  });

  it("updates a custom preset in place", async () => {
    await callAction(SHOP_A, { intent: "create", name: "Original", mood: "cozy" });
    const loaded = await callLoader(SHOP_A);
    const id = loaded.presets.find((p) => p.isCustom)!.id;

    const updateResult = await callAction(SHOP_A, { intent: "update", id, name: "Renamed", mood: "bright" });
    expect(updateResult).toEqual({ ok: true });

    const reloaded = await callLoader(SHOP_A);
    const updated = reloaded.presets.find((p) => p.isCustom)!;
    expect(updated.name).toBe("Renamed");
    expect((updated.attributes as Record<string, unknown>).mood).toBe("bright");
  });

  it("refuses to edit a built-in preset", async () => {
    const result = await callAction(SHOP_A, { intent: "update", id: "minimal-studio", name: "Hijacked" });
    expect(result).toEqual({ ok: false, error: "Built-in presets can't be edited or deleted." });
  });

  it("refuses to edit another shop's preset, reporting it as simply not found", async () => {
    await callAction(SHOP_B, { intent: "create", name: "Shop B Only" });
    const loadedB = await callLoader(SHOP_B);
    const idB = loadedB.presets.find((p) => p.isCustom)!.id;

    const result = await callAction(SHOP_A, { intent: "update", id: idB, name: "Hijacked" });
    expect(result).toEqual({ ok: false, error: "That preset no longer exists." });
  });

  it("deletes a custom preset", async () => {
    await callAction(SHOP_A, { intent: "create", name: "To Delete" });
    const loaded = await callLoader(SHOP_A);
    const id = loaded.presets.find((p) => p.isCustom)!.id;

    const deleteResult = await callAction(SHOP_A, { intent: "delete", id });
    expect(deleteResult).toEqual({ ok: true });

    const reloaded = await callLoader(SHOP_A);
    expect(reloaded.presets.some((p) => p.isCustom)).toBe(false);
  });
});

describe("app.presets — default preset", () => {
  it("sets and clears the shop's default preset", async () => {
    const setResult = await callAction(SHOP_A, { intent: "set-default", id: "minimal-studio" });
    expect(setResult).toEqual({ ok: true });
    expect((await callLoader(SHOP_A)).defaultPresetId).toBe("minimal-studio");

    const clearResult = await callAction(SHOP_A, { intent: "set-default", id: "" });
    expect(clearResult).toEqual({ ok: true });
    expect((await callLoader(SHOP_A)).defaultPresetId).toBeNull();
  });

  it("is scoped per shop", async () => {
    await callAction(SHOP_A, { intent: "set-default", id: "minimal-studio" });
    expect((await callLoader(SHOP_B)).defaultPresetId).toBeNull();
  });
});
