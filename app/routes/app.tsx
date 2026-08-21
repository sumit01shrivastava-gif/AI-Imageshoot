import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { requireAdminContext } from "../../services/shopify";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Every /app/* route nests under this layout, so authenticating here
  // (via the shared requireAdminContext entry point — see CLAUDE.md
  // "Security requirements") guards all of them.
  await requireAdminContext(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/products">Products</s-link>
        <s-link href="/app/store-visuals">Store Visuals</s-link>
        <s-link href="/app/assets">AI Assets</s-link>
        <s-link href="/app/presets">Brand Styles</s-link>
        <s-link href="/app/publishing">Publishing</s-link>
        <s-link href="/app/usage">Usage</s-link>
        <s-link href="/app/billing">Billing</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
