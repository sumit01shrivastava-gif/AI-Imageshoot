/**
 * Standalone (non-Shopify) sign-up/sign-in orchestration — the service
 * layer behind /signup and /login. See docs/roadmap.md "Two experiences,
 * one core" for the architecture this implements.
 */
import { hashPassword, verifyPassword } from "../../lib/auth/password.server";
import { createUser, findUserByEmail } from "../../db/repositories/user.repository";
import { createWorkspaceForUser, getDefaultWorkspaceForUser } from "../../db/repositories/workspace.repository";
import type { User, Workspace } from "@prisma/client";

export class EmailAlreadyRegisteredError extends Error {
  constructor() {
    super("An account with this email already exists.");
    this.name = "EmailAlreadyRegisteredError";
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super("Incorrect email or password.");
    this.name = "InvalidCredentialsError";
  }
}

const MIN_PASSWORD_LENGTH = 8;

export class WeakPasswordError extends Error {
  constructor() {
    super(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    this.name = "WeakPasswordError";
  }
}

/** Creates a new User + their default Workspace (+ membership) in one
 * transaction (see workspace.repository.ts's `createWorkspaceForUser`).
 * Every standalone account gets exactly one workspace at signup — see
 * prisma/schema.prisma's WorkspaceMembership doc comment for why more
 * than one is representable later without a migration, even though
 * nothing creates a second one yet. */
export async function signUp(email: string, password: string): Promise<{ user: User; workspace: Workspace }> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new WeakPasswordError();
  }
  const existing = await findUserByEmail(email);
  if (existing) {
    throw new EmailAlreadyRegisteredError();
  }

  const passwordHash = await hashPassword(password);
  const user = await createUser(email, passwordHash);
  const workspace = await createWorkspaceForUser(user.id, "My Workspace");
  return { user, workspace };
}

export async function signIn(email: string, password: string): Promise<User> {
  const user = await findUserByEmail(email);
  if (!user) {
    throw new InvalidCredentialsError();
  }
  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    throw new InvalidCredentialsError();
  }
  return user;
}

/** A signed-in user should always have a default workspace (created
 * atomically at signup) — this is a defensive read, not a "create on
 * demand" path, so a missing workspace surfaces as `null` rather than
 * silently fabricating one. */
export async function getDefaultWorkspace(userId: string): Promise<Workspace | null> {
  return getDefaultWorkspaceForUser(userId);
}
