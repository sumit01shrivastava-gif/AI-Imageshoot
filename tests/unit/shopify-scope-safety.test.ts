/**
 * Regression guard for the Shopify write-scope boundary (see the Phase
 * 0/1 security audit, docs/shopify-integration.md "Access scopes", and
 * docs/publishing.md "Required scope"):
 *
 *   - The actual configured Shopify scope — read from shopify.app.toml and
 *     .env.example, the real files that drive `shopify app deploy` and
 *     local setup, not a hardcoded copy of what we *think* they say — must
 *     be `read_products`, never `write_products`. Still true even after
 *     the publishing pass below: the mutation exists in code, gated
 *     behind a scope this app doesn't request yet, so it can never
 *     actually succeed against a real store today — see
 *     services/shopify/publish-media.server.ts's doc comment.
 *   - No file under app/ or services/ defines a GraphQL `mutation`,
 *     EXCEPT the one, single, deliberately-reviewed file that implements
 *     Shopify publishing (`services/shopify/publish-media.server.ts` —
 *     see PUBLISHING_MUTATION_ALLOWLIST below). Any mutation appearing
 *     ANYWHERE ELSE fails this test — this still catches the exact
 *     failure mode the original version of this test was written to
 *     prevent (an accidental/undiscussed write introduced elsewhere),
 *     just no longer pretends the one intentional, scope-gated exception
 *     doesn't exist.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function listSourceFiles(dir: string): string[] {
  const full = join(ROOT, dir);
  const entries = readdirSync(full);
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = join(full, entry);
    const stat = statSync(entryPath);
    if (stat.isDirectory()) {
      files.push(...listSourceFiles(join(dir, entry)));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(entryPath);
    }
  }
  return files;
}

describe("Shopify access scope (Phase 1 is read-only)", () => {
  it("shopify.app.toml's [access_scopes] requests read_products, not write_products", () => {
    const toml = read("shopify.app.toml");
    const match = toml.match(/^\s*scopes\s*=\s*"([^"]*)"/m);
    expect(match, 'expected `scopes = "..."` under [access_scopes] in shopify.app.toml').not.toBeNull();

    const scopes = match![1].split(",").map((s) => s.trim());
    expect(scopes).toContain("read_products");
    expect(scopes).not.toContain("write_products");
  });

  it(".env.example's default SHOPIFY_SCOPES is read_products, not write_products", () => {
    const example = read(".env.example");
    const match = example.match(/^SHOPIFY_SCOPES=(.*)$/m);
    expect(match, "expected SHOPIFY_SCOPES=... in .env.example").not.toBeNull();

    const scopes = match![1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(scopes).toContain("read_products");
    expect(scopes).not.toContain("write_products");
  });
});

/** The actual GraphQL operation keyword — `mutation` at the start of an
 * operation definition (optionally named, optionally with variables),
 * e.g. `mutation Foo(` or `mutation {`. Deliberately narrower than a bare
 * `/\bmutation\b/i` word match, which false-positives on ordinary English
 * prose in doc comments (e.g. "the publish mutation needs..." in a
 * comment isn't a GraphQL document). */
const GRAPHQL_MUTATION_PATTERN = /\bmutation\s*(\w+\s*)?[({]/;

/** The one, single file allowed to define a GraphQL mutation — see this
 * file's module doc comment. Any mutation appearing in any OTHER file is
 * still a hard failure below. */
const PUBLISHING_MUTATION_ALLOWLIST = ["services/shopify/publish-media.server.ts"];

describe("Shopify GraphQL operations are read-only, except the one reviewed publishing exception", () => {
  it("services/products/shopify-queries.server.ts defines queries only, never a mutation", () => {
    const source = read("services/products/shopify-queries.server.ts");
    expect(source).not.toMatch(GRAPHQL_MUTATION_PATTERN);
    // Sanity check: the file does define GraphQL query documents, so the
    // assertion above isn't vacuously true.
    expect(source).toMatch(/\bquery\b/);
  });

  it("no file under app/ or services/ defines a GraphQL mutation, except the allowlisted publishing file", () => {
    const files = [...listSourceFiles("app"), ...listSourceFiles("services")];
    expect(files.length).toBeGreaterThan(10); // sanity: we actually scanned real files

    const offenders = files
      .map((file) => file.replace(ROOT + "/", ""))
      .filter((relativePath) => !PUBLISHING_MUTATION_ALLOWLIST.includes(relativePath))
      .filter((relativePath) => GRAPHQL_MUTATION_PATTERN.test(readFileSync(join(ROOT, relativePath), "utf8")));

    expect(offenders).toEqual([]);
  });

  it("the allowlisted publishing file really does define exactly the one expected mutation", () => {
    // Guards the allowlist itself from silently covering for an
    // unrelated/additional mutation slipping into the same file later —
    // this must stay in lockstep with the intended, reviewed scope.
    const source = read(PUBLISHING_MUTATION_ALLOWLIST[0]);
    const matches = source.match(new RegExp(GRAPHQL_MUTATION_PATTERN, "g")) ?? [];
    expect(matches).toHaveLength(1);
    expect(source).toContain("productCreateMedia");
  });

  it("the publishing mutation's own required scope (write_products) is still NOT actually requested", () => {
    // The mutation existing in code and the scope it needs being granted
    // are two different things — this is the assertion that actually
    // keeps publishing inert against a real store today. See
    // docs/publishing.md "Required scope". Checks the real `scopes =
    // "..."`/`SHOPIFY_SCOPES=...` VALUES specifically (like the two tests
    // above), not a blunt substring search of the whole file — both
    // files legitimately mention "write_products" in prose/comments
    // explaining why it's deliberately absent.
    const toml = read("shopify.app.toml");
    const tomlMatch = toml.match(/^\s*scopes\s*=\s*"([^"]*)"/m);
    const tomlScopes = tomlMatch![1].split(",").map((s) => s.trim());
    expect(tomlScopes).not.toContain("write_products");

    const example = read(".env.example");
    const envMatch = example.match(/^SHOPIFY_SCOPES=(.*)$/m);
    const envScopes = envMatch![1].split(",").map((s) => s.trim()).filter(Boolean);
    expect(envScopes).not.toContain("write_products");
  });
});
