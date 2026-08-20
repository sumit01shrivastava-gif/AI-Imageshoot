/**
 * Vitest global setup.
 *
 * Provides safe, non-secret default env values so the suite is
 * self-contained and doesn't require a developer's local .env to run
 * (important for CI). Values are only filled in when not already set, so
 * `npm test` still honors a real .env if one is loaded.
 *
 * DATABASE_URL/REDIS_URL point at the docker-compose local services
 * (non-default ports — see docker-compose.yml) since some integration
 * tests exercise real client construction against them.
 */
import { resetEnvCacheForTests } from "../lib/validation/env.server";

process.env.NODE_ENV ??= "test";
process.env.SHOPIFY_API_KEY ??= "test_api_key";
process.env.SHOPIFY_API_SECRET ??= "test_api_secret";
process.env.SHOPIFY_APP_URL ??= "https://example.com";
process.env.SHOPIFY_SCOPES ??= "write_products";
process.env.DATABASE_URL ??=
  "postgresql://postgres:postgres@localhost:5433/ai_imageshoot?schema=public";
process.env.REDIS_URL ??= "redis://localhost:6380";

resetEnvCacheForTests();
