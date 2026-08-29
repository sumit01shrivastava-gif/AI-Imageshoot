/** Keeps visual-fixture availability explicit and independently testable. */
export function isStudioFixtureEnabled(nodeEnv = process.env.NODE_ENV): boolean {
  return nodeEnv !== "production";
}
