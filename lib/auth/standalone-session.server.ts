/**
 * Standalone (non-Shopify) login session — a cookie session storage
 * completely separate from Shopify's own `Session` model/storage
 * (`@shopify/shopify-app-session-storage-prisma`, untouched by this file).
 * Only ever holds a `userSessionId`, pointing at one `UserSession` row —
 * the row itself (and its `tokenHash`) is the actual source of truth;
 * losing/rotating the cookie secret only ever invalidates the cookie's own
 * signature, never a stored credential.
 */
import { createCookieSessionStorage, redirect } from "react-router";
import { randomBytes, createHash } from "node:crypto";
import { getEnv } from "../validation/env.server";
import prisma from "../../db/client.server";
import type { AuthContext } from "./types";

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function sessionSecret(): string {
  const env = getEnv();
  return env.SESSION_SECRET ?? `standalone-session-fallback:${env.SHOPIFY_API_SECRET}`;
}

const storage = createCookieSessionStorage({
  cookie: {
    name: "__ais_session",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DURATION_MS / 1000,
    get secrets() {
      return [sessionSecret()];
    },
  },
});

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Creates a new `UserSession` row (only the token's hash is persisted)
 * and returns a `Set-Cookie` header value carrying the raw token. */
export async function createUserSession(userId: string): Promise<{ setCookie: string }> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
  const userSession = await prisma.userSession.create({
    data: { userId, tokenHash: hashToken(token), expiresAt },
  });

  const session = await storage.getSession();
  session.set("userSessionId", userSession.id);
  session.set("token", token);
  const setCookie = await storage.commitSession(session);
  return { setCookie };
}

export async function destroyUserSession(request: Request): Promise<{ setCookie: string }> {
  const session = await storage.getSession(request.headers.get("Cookie"));
  const userSessionId = session.get("userSessionId") as string | undefined;
  if (userSessionId) {
    await prisma.userSession.delete({ where: { id: userSessionId } }).catch(() => undefined);
  }
  return { setCookie: await storage.destroySession(session) };
}

export class NotAuthenticatedError extends Error {
  constructor() {
    super("Not authenticated");
    this.name = "NotAuthenticatedError";
  }
}

/** Resolves the current request's standalone login into an
 * `{ userId, workspaceId }` pair, verifying the session's raw token
 * against the stored hash and that it hasn't expired. Never trusts the
 * cookie's own claims alone — the token must match what's on the
 * `UserSession` row. */
async function resolveUserSession(request: Request): Promise<{ userId: string; userSessionId: string } | null> {
  const session = await storage.getSession(request.headers.get("Cookie"));
  const userSessionId = session.get("userSessionId") as string | undefined;
  const token = session.get("token") as string | undefined;
  if (!userSessionId || !token) return null;

  const row = await prisma.userSession.findUnique({ where: { id: userSessionId } });
  if (!row || row.expiresAt < new Date()) return null;
  if (row.tokenHash !== hashToken(token)) return null;

  return { userId: row.userId, userSessionId: row.id };
}

/**
 * Resolves the request's standalone login into an `AuthContext` scoped to
 * the user's default workspace — the exact shape
 * `services/shopify/admin-context.server.ts`'s `requireAdminContext`
 * already returns for Shopify requests, so every existing service
 * function works against either unmodified. Redirects to `/login` (never
 * throws a raw 401) when there's no valid session, mirroring
 * `requireAdminContext`'s own "redirect into auth" behavior.
 */
export async function requireWorkspaceContext(request: Request): Promise<{ context: AuthContext; userId: string; workspaceId: string }> {
  const resolved = await getWorkspaceContext(request);
  if (!resolved) {
    throw redirect("/login");
  }
  return resolved;
}

/**
 * Same resolution as `requireWorkspaceContext`, but returns `null` instead
 * of redirecting when there's no valid session — for the handful of
 * routes (signup/login) where "not authenticated" is the expected,
 * desired state, not something to redirect away from. Keeps
 * `requireWorkspaceContext` itself simple/throwing for every ordinary
 * `/studio/*` route, matching `requireAdminContext`'s own shape.
 */
export async function getWorkspaceContext(request: Request): Promise<{ context: AuthContext; userId: string; workspaceId: string } | null> {
  const resolved = await resolveUserSession(request);
  if (!resolved) return null;

  const membership = await prisma.workspaceMembership.findFirst({
    where: { userId: resolved.userId },
    orderBy: { createdAt: "asc" },
    include: { workspace: true },
  });
  if (!membership) {
    // A User row should never exist without a default workspace (see
    // services/workspace/signup.server.ts) — if it somehow does, this is
    // an honest "not authenticated" outcome, not a crash.
    return null;
  }

  return {
    context: { shop: membership.workspace.tenantKey, sessionId: resolved.userSessionId, isOnline: true },
    userId: resolved.userId,
    workspaceId: membership.workspaceId,
  };
}
