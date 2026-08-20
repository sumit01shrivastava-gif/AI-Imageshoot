/**
 * Client-side selection state for the Products → Image selection workflow.
 *
 * This is intentionally ephemeral, in-memory React state — it exists only
 * so the merchant can click through products and images quickly (list →
 * detail → back to list → another product → ...) without a network
 * round-trip per click, and so the review screen
 * (app/routes/app.products.selection.tsx) can render thumbnails/titles
 * without a second fetch (each selected image's display data is captured
 * at the moment it's selected, from data the page already loaded).
 *
 * It is NOT the system of record for a selection: when the merchant clicks
 * "Continue" on the review screen, the selected ids (not the display data)
 * are posted to the server, re-validated (shop ownership, product/media
 * consistency — never trusting the client-side snapshot), and persisted as
 * an `ImageSelection` — see services/products/selection.server.ts and
 * app/routes/app.products.selection.tsx. That persisted record is what a
 * future phase will consume; this context is only the interactive-editing
 * layer on top of it (see prisma/schema.prisma's `ImageSelection` model
 * comment for why the persisted record is minimal).
 *
 * Provided once, at the `app/products` layout route
 * (app/routes/app.products.tsx), so it survives client-side navigation
 * between the list, detail, and review routes.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export type ProductSelectionState = "none" | "some" | "all";

export interface SelectableProduct {
  id: string;
  title: string;
  handle: string;
}

export interface SelectableImage {
  id: string;
  url: string;
  altText: string | null;
}

interface SelectedProductEntry {
  product: SelectableProduct;
  images: Map<string, SelectableImage>;
}

export interface SelectionSummaryEntry {
  product: SelectableProduct;
  images: SelectableImage[];
}

interface SelectionContextValue {
  isImageSelected: (productId: string, productMediaId: string) => boolean;
  toggleImage: (product: SelectableProduct, image: SelectableImage) => void;
  /** Replaces the full set of selected images for one product — used by
   * "select all images" / "clear this product". */
  setProductImages: (product: SelectableProduct, images: SelectableImage[]) => void;
  /** "none" | "some" | "all", given the product's full list of image ids —
   * drives the list row checkbox's checked/indeterminate state. */
  productSelectionState: (productId: string, allImageIds: string[]) => ProductSelectionState;
  selectedCountForProduct: (productId: string) => number;
  clearAll: () => void;
  productCount: number;
  imageCount: number;
  /** Grouped, display-ready snapshot for the review screen. */
  summary: SelectionSummaryEntry[];
  /** Flattened `{ productId, productMediaId }` pairs — what gets posted to
   * the server on "Continue". */
  entries: Array<{ productId: string; productMediaId: string }>;
}

const SelectionContext = createContext<SelectionContextValue | null>(null);

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selection, setSelection] = useState<Record<string, SelectedProductEntry>>({});

  const isImageSelected = useCallback(
    (productId: string, productMediaId: string) => selection[productId]?.images.has(productMediaId) ?? false,
    [selection],
  );

  const toggleImage = useCallback((product: SelectableProduct, image: SelectableImage) => {
    setSelection((prev) => {
      const next = { ...prev };
      const images = new Map(next[product.id]?.images ?? []);
      if (images.has(image.id)) {
        images.delete(image.id);
      } else {
        images.set(image.id, image);
      }
      if (images.size === 0) {
        delete next[product.id];
      } else {
        next[product.id] = { product, images };
      }
      return next;
    });
  }, []);

  const setProductImages = useCallback((product: SelectableProduct, images: SelectableImage[]) => {
    setSelection((prev) => {
      const next = { ...prev };
      if (images.length === 0) {
        delete next[product.id];
      } else {
        next[product.id] = { product, images: new Map(images.map((image) => [image.id, image])) };
      }
      return next;
    });
  }, []);

  const productSelectionState = useCallback(
    (productId: string, allImageIds: string[]): ProductSelectionState => {
      const current = selection[productId];
      if (!current || current.images.size === 0) return "none";
      if (allImageIds.length > 0 && allImageIds.every((id) => current.images.has(id))) return "all";
      return "some";
    },
    [selection],
  );

  const selectedCountForProduct = useCallback(
    (productId: string) => selection[productId]?.images.size ?? 0,
    [selection],
  );

  const clearAll = useCallback(() => setSelection({}), []);

  const { productCount, imageCount, entries, summary } = useMemo(() => {
    const entries: Array<{ productId: string; productMediaId: string }> = [];
    const summary: SelectionSummaryEntry[] = [];
    for (const { product, images } of Object.values(selection)) {
      const imageList = [...images.values()];
      summary.push({ product, images: imageList });
      for (const image of imageList) {
        entries.push({ productId: product.id, productMediaId: image.id });
      }
    }
    return { productCount: summary.length, imageCount: entries.length, entries, summary };
  }, [selection]);

  const value = useMemo<SelectionContextValue>(
    () => ({
      isImageSelected,
      toggleImage,
      setProductImages,
      productSelectionState,
      selectedCountForProduct,
      clearAll,
      productCount,
      imageCount,
      summary,
      entries,
    }),
    [
      isImageSelected,
      toggleImage,
      setProductImages,
      productSelectionState,
      selectedCountForProduct,
      clearAll,
      productCount,
      imageCount,
      summary,
      entries,
    ],
  );

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useSelection(): SelectionContextValue {
  const context = useContext(SelectionContext);
  if (!context) {
    throw new Error("useSelection must be used within a SelectionProvider");
  }
  return context;
}
