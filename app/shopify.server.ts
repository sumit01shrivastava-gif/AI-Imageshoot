// Thin re-export — the real Shopify SDK initialization lives in
// services/shopify/client.server.ts (see that file for why). Kept at this
// path so React Router route modules can use the conventional relative
// `../shopify.server` import.
export {
  default,
  addDocumentResponseHeaders,
  apiVersion,
  authenticate,
  login,
  registerWebhooks,
  sessionStorage,
  unauthenticated,
} from "../services/shopify/client.server";
