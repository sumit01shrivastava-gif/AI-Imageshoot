/**
 * Regression guard for the Phase 1 "read-only" property (see the Phase 0/1
 * security audit and docs/shopify-integration.md "Access scopes"):
 *
 *   - The actual configured Shopify scope — read from shopify.app.toml and
 *     .env.example, the real files that drive `shopify app deploy` and
 *     local setup, not a hardcoded copy of what we *think* they say — must
 *     be `read_products`, never `write_products`.
 *   - No file under app/ or services/ (the shipped app, not tests/docs)
 *     defines a GraphQL `mutation`. Phase 1 never writes to Shopify;
 *     `write_products` is deliberately not requested, and this is the
 *     thing that would silently stop being true if a mutation were added
 *     without also revisiting the scope.
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

describe("Phase 1 Shopify GraphQL operations are read-only", () => {
  it("services/products/shopify-queries.server.ts defines queries only, never a mutation", () => {
    const source = read("services/products/shopify-queries.server.ts");
    expect(source).not.toMatch(/\bmutation\b/i);
    // Sanity check: the file does define GraphQL query documents, so the
    // assertion above isn't vacuously true.
    expect(source).toMatch(/\bquery\b/);
  });

  it("no file under app/ or services/ defines a GraphQL mutation", () => {
    const files = [...listSourceFiles("app"), ...listSourceFiles("services")];
    expect(files.length).toBeGreaterThan(10); // sanity: we actually scanned real files

    const offenders = files.filter((file) => /\bmutation\b/i.test(readFileSync(file, "utf8")));

    expect(offenders.map((f) => f.replace(ROOT + "/", ""))).toEqual([]);
  });
});
