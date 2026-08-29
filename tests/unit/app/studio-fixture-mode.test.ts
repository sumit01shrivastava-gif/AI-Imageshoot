import { describe, expect, it } from "vitest";
import { isStudioFixtureEnabled } from "../../../app/components/studio-fixture-mode";

describe("Studio visual fixture availability", () => {
  it("is impossible in a production runtime", () => {
    expect(isStudioFixtureEnabled("production")).toBe(false);
  });

  it("is available only for local and test visual QA", () => {
    expect(isStudioFixtureEnabled("development")).toBe(true);
    expect(isStudioFixtureEnabled("test")).toBe(true);
  });
});
