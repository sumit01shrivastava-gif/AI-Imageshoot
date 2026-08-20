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
  // Optional at this phase: no storage provider is wired up yet (Step 5 is
  // an abstraction only). Left undefined until a provider is selected.
  OBJECT_STORAGE_PROVIDER: z.string().optional(),
  OBJECT_STORAGE_BUCKET: z.string().optional(),
  OBJECT_STORAGE_ENDPOINT: z.string().optional(),
  OBJECT_STORAGE_ACCESS_KEY: z.string().optional(),
  OBJECT_STORAGE_SECRET_KEY: z.string().optional(),

  // --- AI provider ---------------------------------------------------------
  // Optional at this phase: no AI provider is wired up yet (Step 4 is an
  // abstraction only). Never holds real credentials in this repo's .env.example.
  AI_PROVIDER: z.string().optional(),
  AI_PROVIDER_API_KEY: z.string().optional(),
  AI_PROVIDER_BASE_URL: z.string().optional(),

  PORT: z.coerce.number().int().positive().optional(),
});

export type Env = z.infer<typeof envSchema>;

/** Field names whose values must never be logged, even at debug level. */
export const SECRET_ENV_KEYS = [
  "SHOPIFY_API_SECRET",
  "DATABASE_URL",
  "REDIS_URL",
  "OBJECT_STORAGE_ACCESS_KEY",
  "OBJECT_STORAGE_SECRET_KEY",
  "AI_PROVIDER_API_KEY",
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
