/**
 * Brand style presets — merchant-facing preset management. See
 * docs/lifestyle-generation.md "Brand style presets". Lists the 6
 * built-in presets (read-only — name/description/attributes shown, no
 * edit/delete) alongside the shop's own saved custom presets
 * (create/edit/delete), and lets the merchant set/clear their shop-wide
 * default preset (used to pre-select the picker on the generation
 * routes; never required).
 *
 * Deliberately NOT a design-editor overbuild: attributes are a short set
 * of plain text fields (visual tone, photography style, background,
 * lighting, environment, mood, color direction) — no color picker, no
 * multi-step wizard, no image upload. Every generation route that
 * resolves a preset (services/generation/build-plan.ts,
 * services/store-visuals/build-plan.ts) already tolerates any subset of
 * these being unset, filling gaps with category-aware defaults.
 */
import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";

import { requireAdminContext } from "../../services/shopify";
import {
  listAvailablePresets,
  createCustomPreset,
  updateCustomPreset,
  deleteCustomPreset,
  getDefaultPresetId,
  setDefaultPresetId,
  InvalidPresetNameError,
  PresetNotFoundError,
  BuiltInPresetImmutableError,
  DuplicatePresetNameError,
} from "../../services/generation/brand-style-preset.server";
import { InvalidBrandStylePresetError, type BrandStylePresetAttributes } from "../../services/generation/schema";
import { logger } from "../../lib/logging/logger.server";

const GENERIC_ERROR = "Couldn't save that right now. Please try again.";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { context } = await requireAdminContext(request);
  const [presets, defaultPresetId] = await Promise.all([listAvailablePresets(context), getDefaultPresetId(context)]);
  return { presets, defaultPresetId };
};

// One text field per BrandStylePresetAttributesSchema field this UI
// exposes — deliberately a subset (props/negativeConstraints/colorPalette
// are array fields the deterministic preset examples use sparingly and
// aren't worth a repeating-field-group UI for a v1 preset editor).
const ATTRIBUTE_FIELDS = [
  "visualTone",
  "photographyStyle",
  "backgroundStyle",
  "lightingStyle",
  "environment",
  "mood",
  "colorDirection",
] as const;

function readAttributesFromForm(formData: FormData): BrandStylePresetAttributes {
  const attributes: Record<string, string> = {};
  for (const field of ATTRIBUTE_FIELDS) {
    const value = formData.get(field);
    if (typeof value === "string" && value.trim().length > 0) {
      attributes[field] = value.trim();
    }
  }
  return attributes as BrandStylePresetAttributes;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { context } = await requireAdminContext(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  try {
    if (intent === "create") {
      const name = formData.get("name");
      const description = formData.get("description");
      await createCustomPreset(context, {
        name: typeof name === "string" ? name : "",
        description: typeof description === "string" && description.length > 0 ? description : null,
        attributes: readAttributesFromForm(formData),
      });
      return { ok: true as const };
    }

    if (intent === "update") {
      const id = formData.get("id");
      const name = formData.get("name");
      const description = formData.get("description");
      if (typeof id !== "string") return { ok: false as const, error: GENERIC_ERROR };
      await updateCustomPreset(context, id, {
        name: typeof name === "string" ? name : undefined,
        description: typeof description === "string" ? description : undefined,
        attributes: readAttributesFromForm(formData),
      });
      return { ok: true as const };
    }

    if (intent === "delete") {
      const id = formData.get("id");
      if (typeof id !== "string") return { ok: false as const, error: GENERIC_ERROR };
      await deleteCustomPreset(context, id);
      return { ok: true as const };
    }

    if (intent === "set-default") {
      const id = formData.get("id");
      await setDefaultPresetId(context, typeof id === "string" && id.length > 0 ? id : null);
      return { ok: true as const };
    }

    return { ok: false as const, error: "Unknown action." };
  } catch (error) {
    if (
      error instanceof InvalidPresetNameError ||
      error instanceof InvalidBrandStylePresetError ||
      error instanceof DuplicatePresetNameError ||
      error instanceof BuiltInPresetImmutableError
    ) {
      return { ok: false as const, error: error.message };
    }
    if (error instanceof PresetNotFoundError) {
      return { ok: false as const, error: "That preset no longer exists." };
    }
    logger.error("brand_style_presets.action_failed", {
      shop: context.shop,
      error: error instanceof Error ? error.message : "unknown error",
    });
    return { ok: false as const, error: GENERIC_ERROR };
  }
};

const EMPTY_ATTRIBUTES: Record<(typeof ATTRIBUTE_FIELDS)[number], string> = {
  visualTone: "",
  photographyStyle: "",
  backgroundStyle: "",
  lightingStyle: "",
  environment: "",
  mood: "",
  colorDirection: "",
};

interface PresetFormState {
  isOpen: boolean;
  editingId: string | null;
  name: string;
  description: string;
  attributes: Record<string, string>;
}

const CLOSED_FORM: PresetFormState = { isOpen: false, editingId: null, name: "", description: "", attributes: EMPTY_ATTRIBUTES };

export default function BrandStylePresets() {
  const { presets, defaultPresetId } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [form, setForm] = useState<PresetFormState>(CLOSED_FORM);

  // "Adjusting state when a prop changes" (react.dev/learn/you-might-not-
  // need-an-effect) rather than an effect: closing the form is a direct
  // response to this render's `fetcher.data` differing from the last one
  // we've seen, computed during render, not as a side effect after paint
  // — React re-renders immediately with the adjusted state before
  // anything commits. Keeps this out of useEffect entirely so it's not
  // an effect-triggered setState.
  const [lastHandledFetcherData, setLastHandledFetcherData] = useState(fetcher.data);
  if (fetcher.data !== lastHandledFetcherData) {
    setLastHandledFetcherData(fetcher.data);
    if (fetcher.data?.ok) {
      setForm(CLOSED_FORM);
    }
  }

  const isSubmitting = fetcher.state !== "idle";

  // Effect reserved for the one genuine external-system call (the toast)
  // — no setState here, so this can't cascade re-renders.
  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.ok) {
      shopify.toast.show("Saved");
    } else {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  const builtIns = presets.filter((preset) => !preset.isCustom);
  const custom = presets.filter((preset) => preset.isCustom);

  const startEdit = (preset: (typeof presets)[number]) => {
    const nextAttributes = { ...EMPTY_ATTRIBUTES };
    for (const field of ATTRIBUTE_FIELDS) {
      const value = (preset.attributes as Record<string, unknown>)[field];
      if (typeof value === "string") nextAttributes[field] = value;
    }
    setForm({ isOpen: true, editingId: preset.id, name: preset.name, description: preset.description ?? "", attributes: nextAttributes });
  };

  const startCreate = () => {
    setForm({ isOpen: true, editingId: null, name: "", description: "", attributes: EMPTY_ATTRIBUTES });
  };

  const cancelForm = () => {
    setForm(CLOSED_FORM);
  };

  const submitForm = () => {
    fetcher.submit(
      {
        intent: form.editingId ? "update" : "create",
        ...(form.editingId ? { id: form.editingId } : {}),
        name: form.name,
        description: form.description,
        ...form.attributes,
      },
      { method: "POST" },
    );
  };

  const deletePreset = (id: string, presetName: string) => {
    if (!confirm(`Delete "${presetName}"? Past generations that used it are unaffected.`)) return;
    fetcher.submit({ intent: "delete", id }, { method: "POST" });
  };

  const setDefault = (id: string) => {
    fetcher.submit({ intent: "set-default", id }, { method: "POST" });
  };

  const clearDefault = () => {
    fetcher.submit({ intent: "set-default", id: "" }, { method: "POST" });
  };

  const isFormOpen = form.isOpen;

  return (
    <s-page heading="Brand Style Presets">
      <s-link slot="breadcrumb-actions" href="/app/store-visuals">
        Store Visuals
      </s-link>

      <s-section heading="Built-in presets">
        <s-stack direction="block" gap="base">
          <s-text color="subdued">
            Available to every shop, ready to use — these can&rsquo;t be edited or deleted.
          </s-text>
          {builtIns.map((preset) => (
            <s-stack key={preset.id} direction="inline" gap="base" alignItems="center">
              <s-stack direction="block" gap="small-200">
                <s-text type="strong">{preset.name}</s-text>
                <s-text color="subdued">{preset.description}</s-text>
              </s-stack>
              {defaultPresetId === preset.id ? (
                <s-badge tone="info">Default</s-badge>
              ) : (
                <s-button variant="tertiary" onClick={() => setDefault(preset.id)} disabled={isSubmitting}>
                  Set as default
                </s-button>
              )}
            </s-stack>
          ))}
        </s-stack>
      </s-section>

      <s-section heading="Your custom presets">
        <s-stack direction="block" gap="base">
          {custom.length === 0 && <s-paragraph color="subdued">No custom presets yet.</s-paragraph>}
          {custom.map((preset) => (
            <s-stack key={preset.id} direction="inline" gap="base" alignItems="center">
              <s-stack direction="block" gap="small-200">
                <s-text type="strong">{preset.name}</s-text>
                <s-text color="subdued">{preset.description || "—"}</s-text>
              </s-stack>
              {defaultPresetId === preset.id ? (
                <s-badge tone="info">Default</s-badge>
              ) : (
                <s-button variant="tertiary" onClick={() => setDefault(preset.id)} disabled={isSubmitting}>
                  Set as default
                </s-button>
              )}
              <s-button variant="tertiary" onClick={() => startEdit(preset)} disabled={isSubmitting}>
                Edit
              </s-button>
              <s-button variant="tertiary" tone="critical" onClick={() => deletePreset(preset.id, preset.name)} disabled={isSubmitting}>
                Delete
              </s-button>
            </s-stack>
          ))}

          {defaultPresetId && !presets.some((preset) => preset.id === defaultPresetId) && (
            <s-banner tone="warning">
              <s-paragraph>
                Your default preset was deleted. Generation routes fall back to no preset until you choose a new one.
              </s-paragraph>
              <s-button slot="secondary-actions" variant="tertiary" onClick={clearDefault}>
                Clear default
              </s-button>
            </s-banner>
          )}

          {!isFormOpen && (
            <s-button variant="primary" onClick={startCreate}>
              Create custom preset
            </s-button>
          )}
        </s-stack>
      </s-section>

      {isFormOpen && (
        <s-section heading={form.editingId ? "Edit preset" : "New preset"}>
          <s-stack direction="block" gap="base">
            <s-text-field
              label="Name"
              labelAccessibilityVisibility="visible"
              value={form.name}
              onChange={(event: Event) => setForm((f) => ({ ...f, name: (event.currentTarget as HTMLInputElement).value }))}
            />
            <s-text-field
              label="Description"
              labelAccessibilityVisibility="visible"
              value={form.description}
              onChange={(event: Event) => setForm((f) => ({ ...f, description: (event.currentTarget as HTMLInputElement).value }))}
            />
            <s-text-field
              label="Visual tone"
              labelAccessibilityVisibility="visible"
              placeholder="e.g. minimal, uncluttered"
              value={form.attributes.visualTone}
              onChange={(event: Event) =>
                setForm((f) => ({ ...f, attributes: { ...f.attributes, visualTone: (event.currentTarget as HTMLInputElement).value } }))
              }
            />
            <s-text-field
              label="Photography style"
              labelAccessibilityVisibility="visible"
              placeholder="e.g. studio product photography"
              value={form.attributes.photographyStyle}
              onChange={(event: Event) =>
                setForm((f) => ({
                  ...f,
                  attributes: { ...f.attributes, photographyStyle: (event.currentTarget as HTMLInputElement).value },
                }))
              }
            />
            <s-text-field
              label="Background style"
              labelAccessibilityVisibility="visible"
              placeholder="e.g. seamless neutral backdrop"
              value={form.attributes.backgroundStyle}
              onChange={(event: Event) =>
                setForm((f) => ({
                  ...f,
                  attributes: { ...f.attributes, backgroundStyle: (event.currentTarget as HTMLInputElement).value },
                }))
              }
            />
            <s-text-field
              label="Lighting style"
              labelAccessibilityVisibility="visible"
              placeholder="e.g. soft, even studio lighting"
              value={form.attributes.lightingStyle}
              onChange={(event: Event) =>
                setForm((f) => ({
                  ...f,
                  attributes: { ...f.attributes, lightingStyle: (event.currentTarget as HTMLInputElement).value },
                }))
              }
            />
            <s-text-field
              label="Environment"
              labelAccessibilityVisibility="visible"
              placeholder="e.g. sunlit home interior"
              value={form.attributes.environment}
              onChange={(event: Event) =>
                setForm((f) => ({ ...f, attributes: { ...f.attributes, environment: (event.currentTarget as HTMLInputElement).value } }))
              }
            />
            <s-text-field
              label="Mood"
              labelAccessibilityVisibility="visible"
              placeholder="e.g. warm, comforting"
              value={form.attributes.mood}
              onChange={(event: Event) =>
                setForm((f) => ({ ...f, attributes: { ...f.attributes, mood: (event.currentTarget as HTMLInputElement).value } }))
              }
            />
            <s-text-field
              label="Color direction"
              labelAccessibilityVisibility="visible"
              placeholder="e.g. warm amber and neutral tones"
              value={form.attributes.colorDirection}
              onChange={(event: Event) =>
                setForm((f) => ({
                  ...f,
                  attributes: { ...f.attributes, colorDirection: (event.currentTarget as HTMLInputElement).value },
                }))
              }
            />

            <s-stack direction="inline" gap="base">
              <s-button variant="primary" onClick={submitForm} disabled={isSubmitting} {...(isSubmitting ? { loading: true } : {})}>
                Save
              </s-button>
              <s-button variant="tertiary" onClick={cancelForm} disabled={isSubmitting}>
                Cancel
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
