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
  // An S3-compatible object storage vendor (AWS S3, Cloudflare R2, MinIO,
  // Backblaze B2, DigitalOcean Spaces, ...) — `lib/storage/s3-storage-provider.server.ts`.
  // "s3-compatible" is a protocol, not one commercial vendor: every
  // vendor listed above speaks the identical S3 REST API, so this one
  // implementation covers all of them via `OBJECT_STORAGE_ENDPOINT`. Set
  // `OBJECT_STORAGE_PROVIDER=s3` to select it; unset (the default) keeps
  // using `LocalFilesystemStorageProvider` — see
  // lib/storage/provider.server.ts and docs/storage.md.
  OBJECT_STORAGE_PROVIDER: z.string().optional(),
  OBJECT_STORAGE_BUCKET: z.string().optional(),
  // Required for a non-AWS S3-compatible vendor (R2/MinIO/Spaces/B2);
  // omit for real AWS S3, which resolves its endpoint from the region.
  OBJECT_STORAGE_ENDPOINT: z.string().optional(),
  OBJECT_STORAGE_ACCESS_KEY: z.string().optional(),
  OBJECT_STORAGE_SECRET_KEY: z.string().optional(),
  // SigV4 signing requires a region even for vendors (R2, some MinIO
  // deployments) that don't meaningfully use one — "auto" is Cloudflare
  // R2's own documented convention and a safe default for any vendor that
  // ignores the value.
  OBJECT_STORAGE_REGION: z.string().optional().default("auto"),
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

  // --- Standalone (non-Shopify) authentication ---------------------------
  // Signs the standalone login session cookie (see
  // lib/auth/standalone-session.server.ts). Falls back to a
  // domain-separated derivation of SHOPIFY_API_SECRET when unset — same
  // "zero extra config for dev/test, set your own in production" pattern
  // as MEDIA_SIGNING_SECRET above.
  SESSION_SECRET: z.string().optional(),

  // --- AI provider ---------------------------------------------------------
  // Optional: falls back to `UnconfiguredImageGenerationProvider` (throws
  // on every call) when unset/incomplete — see
  // services/generation/provider.server.ts and docs/ai-pipeline.md
  // "Provider selection". Never holds real credentials in this repo's
  // .env.example. Set to "openai" to select the real, production-selected
  // `OpenAIImageGenerationProvider` (services/ai/openai-image-provider.server.ts)
  // — only AI_PROVIDER_API_KEY is required in that case, not
  // AI_PROVIDER_BASE_URL (OpenAI's API endpoint is the built-in default).
  // Any other non-empty value selects the generic, vendor-agnostic
  // "OpenAI-Images-API-compatible" contract instead
  // (production-image-generation-provider.server.ts), which DOES require
  // AI_PROVIDER_BASE_URL.
  AI_PROVIDER: z.string().optional(),
  AI_PROVIDER_API_KEY: z.string().optional(),
  AI_PROVIDER_BASE_URL: z.string().optional(),
  // Model/version identifier forwarded to the provider — purely a passed
  // -through string (this app never interprets it), recorded onto each
  // GenerationResult's metadata for traceability. Optional; the provider
  // contract's own default applies when unset. Used as the fallback for
  // BOTH of the mode-specific vars below when they're unset — a merchant
  // running one vendor/model for everything only needs to set this one.
  AI_PROVIDER_MODEL: z.string().optional(),
  // Model identifier for a fresh text-to-image request (GenerationMode
  // "TEXT_TO_IMAGE"/absent — every pre-existing generationType). Falls
  // back to AI_PROVIDER_MODEL when unset. See
  // services/ai/production-image-generation-provider.server.ts.
  AI_IMAGE_GENERATION_MODEL: z.string().optional(),
  // Model identifier for an image-editing request (GenerationMode
  // "IMAGE_TO_IMAGE"/"IMAGE_EDIT"/"VARIATION" — the Creative Studio's
  // conversational edits). Many vendors run editing on a materially
  // different model than fresh generation; kept as its own var rather
  // than overloading AI_IMAGE_GENERATION_MODEL. Falls back to
  // AI_PROVIDER_MODEL when unset.
  AI_IMAGE_EDIT_MODEL: z.string().optional(),
  // Per-request timeout, in milliseconds, for
  // production-image-generation-provider.server.ts's outbound calls.
  // Optional — defaults to that file's own DEFAULT_REQUEST_TIMEOUT_MS
  // when unset.
  AI_PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().optional(),

  // --- Image processing provider (Phase 4) --------------------------------
  // Optional: falls back to UnconfiguredImageProcessingProvider (throws on
  // every call) when unset — see services/processing/provider.server.ts.
  // "remove-bg" is the only real vendor wired up (background removal only;
  // enhance/resize run locally, no vendor needed — see docs/image-processing.md
  // "Provider selection"). Never holds a real key in .env.example.
  IMAGE_PROCESSING_PROVIDER: z.string().optional(),
  REMOVE_BG_API_KEY: z.string().optional(),

  // --- Credit entitlement override (development/test only) ---------------
  // A real per-shop plan/subscription system exists (services/billing/plans.ts,
  // ShopSubscription) — this var, when set, overrides the resolved plan's
  // `monthlyCredits` only, so a specific limit can be exercised locally or
  // in a test without seeding a ShopSubscription row. See
  // services/usage/entitlement.server.ts's `getPlan` and docs/usage.md
  // "Entitlement". Never presented to a merchant as a real plan.
  CREATIVE_STUDIO_MONTHLY_CREDITS: z.coerce.number().int().positive().optional(),

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
