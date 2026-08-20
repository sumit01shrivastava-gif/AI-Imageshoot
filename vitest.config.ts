import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    // Integration tests hit a real local Postgres/Redis (docker-compose) and
    // construct the real Shopify SDK — give them room beyond the 5s default.
    testTimeout: 15000,
    // Several integration test files set process.env (AI_PROVIDER,
    // IMAGE_PROCESSING_PROVIDER, STORAGE_LOCAL_ROOT, ...) in their own
    // beforeAll — a well-established pattern here (see e.g.
    // tests/integration/generation/generation-queue.test.ts) that's safe
    // as long as no two such files execute concurrently. Vitest's default
    // file parallelism runs multiple test files' async hooks interleaved
    // in the same process, so process.env is a real shared-mutable-state
    // race between them — confirmed by
    // tests/integration/processing/processing-queue.test.ts intermittently
    // reading a DIFFERENT file's STORAGE_LOCAL_ROOT mid-test. Disabling
    // file parallelism trades some wall-clock time for eliminating that
    // whole class of flake, rather than rearchitecting every file's env
    // seam to avoid global process.env.
    fileParallelism: false,
  },
});
