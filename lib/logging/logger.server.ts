/**
 * Minimal structured logger with built-in secret redaction.
 *
 * Deliberately not a dependency on a logging library: at this stage we only
 * need structured (JSON-in-production, readable-in-development), leveled
 * output with a hard guarantee that secret-shaped values never reach stdout.
 * Swap this for pino/winston later if operational needs grow — nothing else
 * in the codebase should depend on the console directly, only on this
 * module, so that swap stays cheap.
 *
 * Security requirement (see CLAUDE.md "Security Requirements"): no sensitive
 * values in logs. This module redacts by key name (SECRET_ENV_KEYS and any
 * key that looks like a secret) AND by value shape (long opaque tokens),
 * recursively, before anything is serialized.
 */
import { SECRET_ENV_KEYS, getEnv } from "../validation/env.server";

type LogLevel = "debug" | "info" | "warn" | "error";
type LogMeta = Record<string, unknown>;

const REDACTED = "[REDACTED]";

const SECRET_KEY_PATTERN = /secret|token|password|apikey|api_key|accesskey|access_key|authorization/i;
const SECRET_ENV_KEY_SET = new Set<string>(SECRET_ENV_KEYS);

function looksLikeSecretKey(key: string): boolean {
  return SECRET_ENV_KEY_SET.has(key) || SECRET_KEY_PATTERN.test(key);
}

/**
 * The literal values of every currently-configured secret env var
 * (SECRET_ENV_KEYS) — used below to catch a secret that ends up embedded
 * inside an unrelated field's string content (e.g. a vendor/GraphQL error
 * message that happens to echo a credential back), which key-name-based
 * redaction alone can't catch. Recomputed on every call rather than
 * cached: `getEnv()` is already cheap (cached internally) and this keeps
 * a test's `resetEnvCacheForTests()` immediately reflected here too. Never
 * throws — a log call must never fail just because environment validation
 * hasn't run yet or has failed; that failure gets its own log line
 * elsewhere, not a crash inside logging itself. Short values are skipped
 * to avoid redacting incidental substring matches.
 */
function configuredSecretValues(): string[] {
  try {
    const env = getEnv();
    return SECRET_ENV_KEYS.map((key) => env[key]).filter(
      (value): value is string => typeof value === "string" && value.length >= 8,
    );
  } catch {
    return [];
  }
}

function redactSecretSubstrings(value: string): string {
  let result = value;
  for (const secret of configuredSecretValues()) {
    if (result.includes(secret)) result = result.split(secret).join(REDACTED);
  }
  return result;
}

/** Recursively redacts any object value keyed by something secret-shaped,
 * AND any string value (regardless of its key) that contains a currently
 * -configured secret's literal value. */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return redactSecretSubstrings(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, seen));
  }

  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [
        key,
        looksLikeSecretKey(key) ? REDACTED : redact(val, seen),
      ]),
    );
  }

  return value;
}

function write(level: LogLevel, message: string, meta?: LogMeta): void {
  const entry = {
    level,
    time: new Date().toISOString(),
    message,
    ...(meta ? (redact(meta) as LogMeta) : {}),
  };

  const line = JSON.stringify(entry);
  // eslint-disable-next-line no-console
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  sink(line);
}

export const logger = {
  debug: (message: string, meta?: LogMeta) => {
    if (process.env.NODE_ENV !== "production") write("debug", message, meta);
  },
  info: (message: string, meta?: LogMeta) => write("info", message, meta),
  warn: (message: string, meta?: LogMeta) => write("warn", message, meta),
  error: (message: string, meta?: LogMeta) => write("error", message, meta),
};
