/**
 * Persistent summary bar shown across the Products workflow (list, detail)
 * once at least one image is selected — "3 products · 7 source images",
 * a "Clear selection" action, and a "Review & Continue" link into
 * app/routes/app.products.selection.tsx. See app/components/selection-context.tsx.
 */
import { useNavigate } from "react-router";
import { useSelection } from "./selection-context";

export function SelectionBar() {
  const { productCount, imageCount, clearAll } = useSelection();
  const navigate = useNavigate();

  if (imageCount === 0) return null;

  return (
    <s-box
      padding="base"
      borderWidth="base"
      borderRadius="base"
      background="subdued"
    >
      <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
        <s-text>
          {productCount} {productCount === 1 ? "product" : "products"} selected · {imageCount}{" "}
          source {imageCount === 1 ? "image" : "images"}
        </s-text>
        <s-stack direction="inline" gap="base">
          <s-button variant="tertiary" onClick={() => clearAll()}>
            Clear selection
          </s-button>
          <s-button variant="primary" onClick={() => navigate("/app/products/selection")}>
            Review &amp; Continue
          </s-button>
        </s-stack>
      </s-stack>
    </s-box>
  );
}
