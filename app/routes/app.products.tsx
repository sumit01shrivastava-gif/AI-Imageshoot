import { Outlet } from "react-router";
import { SelectionProvider } from "../components/selection-context";

/**
 * Layout route for the Products workflow (list → detail → selection
 * summary). Provides `SelectionProvider` once so the in-progress selection
 * survives client-side navigation between its child routes — see
 * app/components/selection-context.tsx.
 */
export default function ProductsLayout() {
  return (
    <SelectionProvider>
      <Outlet />
    </SelectionProvider>
  );
}
