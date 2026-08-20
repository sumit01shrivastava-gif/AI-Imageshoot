import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    // Integration tests hit a real local Postgres/Redis (docker-compose) and
    // construct the real Shopify SDK — give them room beyond the 5s default.
    testTimeout: 15000,
  },
});
