import { defineConfig } from "@playwright/test";

/**
 * E2E config. See tests/e2e/products.spec.ts and
 * services/shopify/admin-context.server.ts's "E2E test seam" for how these
 * tests authenticate without a real Shopify OAuth flow — required because
 * CLAUDE.md forbids calling a live/production Shopify store from automated
 * tests.
 *
 * `webServer` boots the built app directly (`react-router-serve`, not
 * `shopify app dev`) against the local docker-compose Postgres/Redis, with
 * `NODE_ENV=test` + `ALLOW_E2E_AUTH_BYPASS=1` — both required by the auth
 * seam, and both set nowhere else.
 */
const PORT = 3210;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
  },
  webServer: {
    command: "npm run build && npm run start",
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      ...process.env,
      NODE_ENV: "test",
      ALLOW_E2E_AUTH_BYPASS: "1",
      PORT: String(PORT),
      SHOPIFY_API_KEY: "e2e_test_api_key",
      SHOPIFY_API_SECRET: "e2e_test_api_secret",
      SHOPIFY_APP_URL: `http://localhost:${PORT}`,
      SHOPIFY_SCOPES: "write_products",
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgresql://postgres:postgres@localhost:5433/ai_imageshoot?schema=public",
      REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6380",
    },
  },
});
