/**
 * Password hashing — standalone (non-Shopify) sign-in only.
 *
 * Uses Node's built-in `crypto.scrypt` rather than a third-party library
 * (bcrypt/argon2): a real, well-regarded KDF, zero new dependencies. The
 * stored format is `scrypt:<saltHex>:<hashHex>` — self-describing so a
 * future algorithm change can coexist with old hashes rather than
 * invalidating every existing password.
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  return `scrypt:${salt}:${derived.toString("hex")}`;
}

/** Constant-time comparison — never a plain `===` on the derived hash. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, hashHex] = parts;
  const expected = Buffer.from(hashHex, "hex");
  const actual = (await scryptAsync(password, salt, expected.length)) as Buffer;
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
