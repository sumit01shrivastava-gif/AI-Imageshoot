/**
 * Composes the standalone workspace's "conversation history" (sidebar)
 * and "creations" (gallery) views on top of EXISTING reads only —
 * `listCreativeSessionsForShop` (db/repositories/creative-session.repository.ts),
 * `getFirstUserMessage` (db/repositories/creative-message.repository.ts),
 * `listGenerationJobsForCreativeSession` (db/repositories/generation-job.repository.ts),
 * `resignResultUrls` (lib/storage). No new generation/storage/queue logic
 * lives here — this is a pure read-side composition, exactly like
 * services/assets/asset-library.server.ts's own "merge existing reads,
 * no new model" pattern.
 *
 * A standalone workspace's conversations are naturally grouped one row
 * per `CreativeSession` (a "conversation"), each of which may have
 * produced several `GenerationJob`/`GenerationResult`s (its "versions") —
 * see prisma/schema.prisma's CreativeSession model comment. This groups
 * by conversation rather than flattening to one row per generated image
 * (which is what services/assets/ does for the Shopify AI Assets
 * library), since here a "creation" IS a conversation with its
 * accumulated versions, not an individual image.
 */
import type { AuthContext } from "../../lib/auth/types";
import { listCreativeSessionsForShop, type CreativeSessionStatus } from "../../db/repositories/creative-session.repository";
import { getFirstUserMessage } from "../../db/repositories/creative-message.repository";
import { listGenerationJobsForCreativeSession, type GenerationStatus } from "../../db/repositories/generation-job.repository";
import { resignResultUrls } from "../../lib/storage";

export interface WorkspaceConversationSummary {
  id: string;
  /** Derived from the session's first USER message — never manually
   * named by the merchant (Part 13's "sensible titles... do not require
   * users to manually name every conversation"). "New conversation" for
   * a session with no messages yet (created but never sent to). */
  title: string;
  status: CreativeSessionStatus;
  createdAt: Date;
  updatedAt: Date;
  /** `null` when this conversation has no GenerationJob yet. */
  latestJobStatus: GenerationStatus | null;
  latestJobId: string | null;
  errorMessage: string | null;
  /** Total GenerationResults across every job in this conversation —
   * "Version 1, 2, 3, 4" (Part 11). */
  versionCount: number;
  thumbnailUrl: string | null;
}

const TITLE_MAX_CHARS = 48;

// Strips common imperative openers ("Create a...", "Please make...") and a
// leading article so a title reads like a short subject/noun phrase
// rather than a truncated command sentence — still fully deterministic
// (no extra AI call/cost per conversation; see module doc comment), just
// a better heuristic than raw truncation. Never fabricates a summary
// beyond the merchant's own words — it only trims/reorders what they
// already wrote.
const LEADING_FILLER =
  /^(please\s+)?(can you\s+|could you\s+|i want to\s+|i'd like to\s+|i would like to\s+|create\s+|make\s+|generate\s+|design\s+|build\s+)+/i;
const LEADING_ARTICLE = /^(a|an|the)\s+/i;

function truncateAtWordBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > maxChars * 0.5 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

function deriveTitle(content: string | undefined | null): string {
  const raw = (content ?? "").trim();
  if (raw.length === 0) return "New conversation";

  let cleaned = raw.replace(LEADING_FILLER, "").replace(LEADING_ARTICLE, "").trim();
  // The filler strip ate the entire message (e.g. it really was just
  // "Please create") — fall back to the original rather than titling
  // the conversation with an empty string.
  if (cleaned.length === 0) cleaned = raw;
  cleaned = capitalize(cleaned.replace(/[.!?\s]+$/, ""));

  return truncateAtWordBoundary(cleaned, TITLE_MAX_CHARS);
}

export interface ListWorkspaceConversationsOptions {
  limit?: number;
  /** Signing a thumbnail URL is one extra (cheap, HMAC-only for the
   * default local storage provider) call per conversation — worth
   * skipping for a lightweight sidebar list that never shows images,
   * and worth paying for the actual creations gallery. Defaults to
   * `true`. */
  withThumbnails?: boolean;
}

/** Most-recently-active-first conversation summaries for one workspace.
 * Every field the standalone UI needs for BOTH the sidebar history list
 * and the Creations gallery grid — see each route's own doc comment for
 * which fields it actually renders. */
export async function listWorkspaceConversations(
  context: AuthContext,
  options: ListWorkspaceConversationsOptions = {},
): Promise<WorkspaceConversationSummary[]> {
  const limit = options.limit ?? 40;
  const withThumbnails = options.withThumbnails ?? true;

  const sessions = await listCreativeSessionsForShop(context, limit);

  return Promise.all(
    sessions.map(async (session) => {
      const [firstMessage, jobs] = await Promise.all([
        getFirstUserMessage(context.shop, session.id),
        listGenerationJobsForCreativeSession(context.shop, session.id),
      ]);

      const latestJob = jobs[0] ?? null;
      const versionCount = jobs.reduce((sum, job) => sum + job.results.length, 0);

      let thumbnailUrl: string | null = null;
      if (withThumbnails) {
        const allResults = jobs.flatMap((job) => job.results);
        const current = allResults.find((result) => result.id === session.currentResultId) ?? allResults[0] ?? null;
        if (current) {
          const [signed] = await resignResultUrls([current]);
          thumbnailUrl = signed.url;
        }
      }

      return {
        id: session.id,
        title: deriveTitle(firstMessage?.content),
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        latestJobStatus: latestJob?.status ?? null,
        latestJobId: latestJob?.id ?? null,
        errorMessage: latestJob?.status === "FAILED" ? (latestJob.errorMessage ?? null) : null,
        versionCount,
        thumbnailUrl,
      };
    }),
  );
}
