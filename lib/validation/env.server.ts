/**
 * Environment validation.
 *
 * Every environment variable the app depends on is declared and validated
 * here, once, at import time. Nothing else in the codebase should reach into
 * `process.env` directly for a value declared in this schema — import `env`
 * from this module instead. That gives us:
 *
 *   - a single source of truth for what configuration exists
 *   - a fast, readable failure at boot if something required is missing,
 *     instead of a confusing runtime error deep in a request
 *   - a safe place to keep secret values out of logs (see redactSecrets)
 *
 * See docs/architecture.md ("Configuration") and lib/logging/logger.server.ts.
 */
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  // --- Shopify app configuration --------------------------------------
  // Required: the app cannot authenticate merchants without these.
  SHOPIFY_API_KEY: z.string().min(1, "SHOPIFY_API_KEY is required"),
  SHOPIFY_API_SECRET: z.string().min(1, "SHOPIFY_API_SECRET is required"),
  SHOPIFY_APP_URL: z.url("SHOPIFY_APP_URL must be a valid URL"),
  SHOPIFY_SCOPES: z.string().min(1, "SHOPIFY_SCOPES is required"),
  SHOP_CUSTOM_DOMAIN: z.string().optional(),

  // --- Database ---------------------------------------------------------
  // Required: session storage (and every future domain model) lives here.
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // --- Queue (Redis / BullMQ) --------------------------------------------
  // Optional at boot: only the worker process and job-enqueueing code paths
  // need a reachable Redis. Defaults to the docker-compose local service so
  // `npm run dev` works out of the box in local development.
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),

  // --- Object storage -----------------------------------------------------
  // A real cloud vendor (S3/R2/GCS/...) is still not wired up — these
  // remain declared-but-unread hooks for that future phase (see
  // lib/storage/provider.server.ts). Phase 4 instead persists through
  // `LocalFilesystemStorageProvider`, configured by STORAGE_LOCAL_ROOT
  // below — genuinely persistent (survives a process restart, shared
  // across the web/worker process boundary on one host), just not yet
  // cloud-backed. See docs/image-processing.md "Storage".
  OBJECT_STORAGE_PROVIDER: z.string().optional(),
  OBJECT_STORAGE_BUCKET: z.string().optional(),
  OBJECT_STORAGE_ENDPOINT: z.string().optional(),
  OBJECT_STORAGE_ACCESS_KEY: z.string().optional(),
  OBJECT_STORAGE_SECRET_KEY: z.string().optional(),
  // Directory `LocalFilesystemStorageProvider` reads/writes under. Defaults
  // to a project-local, gitignored directory so `npm run dev`/tests work
  // with zero configuration.
  STORAGE_LOCAL_ROOT: z.string().min(1).default(".data/storage"),
  // HMAC secret for the time-limited signed URLs `app/routes/app.media.$.tsx`
  // verifies (see lib/storage/local-filesystem-provider.server.ts's
  // `getSignedUrl` and docs/image-processing.md "Storage" — plain `<img>`
  // tags can't carry Shopify's session-token bearer auth, so signed URLs
  // are their own, independent proof of authorization instead). Falls back
  // to (a domain-separated derivation of) SHOPIFY_API_SECRET when unset, so
  // dev/test need no extra configuration; production should set its own.
  MEDIA_SIGNING_SECRET: z.string().optional(),

  // --- AI provider ---------------------------------------------------------
  // Optional at this phase: no AI provider is wired up yet (Step 4 is an
  // abstraction only). Never holds real credentials in this repo's .env.example.
  AI_PROVIDER: z.string().optional(),
  AI_PROVIDER_API_KEY: z.string().optional(),
  AI_PROVIDER_BASE_URL: z.string().optional(),

  // --- Image processing provider (Phase 4) --------------------------------
  // Optional: falls back to UnconfiguredImageProcessingProvider (throws on
  // every call) when unset — see services/processing/provider.server.ts.
  // "remove-bg" is the only real vendor wired up (background removal only;
  // enhance/resize run locally, no vendor needed — see docs/image-processing.md
  // "Provider selection"). Never holds a real key in .env.example.
  IMAGE_PROCESSING_PROVIDER: z.string().optional(),
  REMOVE_BG_API_KEY: z.string().optional(),

  PORT: z.coerce.number().int().positive().optional(),

  // --- Testing -------------------------------------------------------------
  // E2E-only opt-in (see services/shopify/admin-context.server.ts). Set only
  // by playwright.config.ts's webServer env — never in .env/.env.example.
  // A second, independent check alongside NODE_ENV==="test"; both must hold.
  ALLOW_E2E_AUTH_BYPASS: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/** Field names whose values must never be logged, even at debug level. */
export const SECRET_ENV_KEYS = [
  "SHOPIFY_API_SECRET",
  "DATABASE_URL",
  "REDIS_URL",
  "OBJECT_STORAGE_ACCESS_KEY",
  "OBJECT_STORAGE_SECRET_KEY",
  "MEDIA_SIGNING_SECRET",
  "AI_PROVIDER_API_KEY",
  "REMOVE_BG_API_KEY",
] as const satisfies readonly (keyof Env)[];

let cachedEnv: Env | undefined;

/**
 * Parses and validates `process.env`. Throws a single, readable error
 * listing every problem found (rather than failing on the first one) so a
 * misconfigured deployment fails loudly and immediately instead of later,
 * mid-request, with a confusing error.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\nCheck .env against .env.example.`,
    );
  }

  return result.data;
}

/** Cached, validated environment. Safe to import anywhere on the server. */
export function getEnv(): Env {
  if (!cachedEnv) {
    cachedEnv = loadEnv();
  }
  return cachedEnv;
}

/** Test-only: clears the cache so a suite can reload with different values. */
export function resetEnvCacheForTests(): void {
  cachedEnv = undefined;
}
