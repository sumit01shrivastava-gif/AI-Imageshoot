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

const TITLE_MAX_CHARS = 64;

function deriveTitle(content: string | undefined | null): string {
  const trimmed = (content ?? "").trim();
  if (trimmed.length === 0) return "New conversation";
  return trimmed.length > TITLE_MAX_CHARS ? `${trimmed.slice(0, TITLE_MAX_CHARS).trimEnd()}…` : trimmed;
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
