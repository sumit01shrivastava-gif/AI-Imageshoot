/**
 * The standalone creations gallery — grouped one card per conversation
 * (a "creation" IS its conversation, with every version underneath it;
 * see services/creative-studio/workspace-library.server.ts's doc
 * comment for why this groups by CreativeSession rather than flattening
 * to one row per GenerationResult the way the Shopify AI Assets library
 * does). Reuses `listWorkspaceConversations` unmodified — no new
 * generation/storage logic.
 */
import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { requireWorkspaceContext } from "../../lib/auth/standalone-session.server";
import { listWorkspaceConversations } from "../../services/creative-studio/workspace-library.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { context } = await requireWorkspaceContext(request);
  const conversations = await listWorkspaceConversations(context, { limit: 60, withThumbnails: true });
  return { conversations };
};

function relativeDate(value: Date | string): string {
  const date = new Date(value);
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function StudioCreations() {
  const { conversations } = useLoaderData<typeof loader>();

  return (
    <div className="studio-page">
      <h1 className="studio-page-heading">Creations</h1>
      <p className="studio-page-sub">Every conversation you&rsquo;ve started, with every version saved.</p>

      {conversations.length === 0 ? (
        <div className="studio-empty-state">
          <div className="studio-empty-icon" aria-hidden="true">
            <svg width="30" height="30" viewBox="0 0 32 32" fill="none">
              <path d="M4 13V5C4 4.44772 4.44772 4 5 4H13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M28 19V27C28 27.5523 27.5523 28 27 28H19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <rect x="13" y="13" width="6" height="6" rx="1.25" fill="currentColor" />
            </svg>
          </div>
          <p className="studio-empty-title">No creations yet.</p>
          <p className="studio-empty-body">Start with an idea, a product photo, or a prompt.</p>
          <Link to="/studio" className="studio-btn" data-variant="primary">
            Create something
          </Link>
        </div>
      ) : (
        <div className="studio-gallery">
          {conversations.map((conversation) => (
            <Link key={conversation.id} to={`/studio/c/${conversation.id}`} className="studio-gallery-card">
              <div className="studio-gallery-thumb">
                {conversation.thumbnailUrl ? (
                  <img src={conversation.thumbnailUrl} alt={conversation.title} />
                ) : (
                  <span className="studio-meta-row">
                    {conversation.latestJobStatus === "FAILED" ? "Failed" : conversation.latestJobStatus ? "In progress…" : "No image yet"}
                  </span>
                )}
              </div>
              <div className="studio-gallery-meta">
                <p className="studio-gallery-title">{conversation.title}</p>
                <p className="studio-gallery-sub">
                  <span>{relativeDate(conversation.updatedAt)}</span>
                  {conversation.versionCount > 1 && <span>· {conversation.versionCount} versions</span>}
                  {conversation.latestJobStatus === "FAILED" && (
                    <span className="studio-badge" data-tone="error">
                      Failed
                    </span>
                  )}
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
