/**
 * Standalone application shell — the non-Shopify counterpart to
 * app/routes/app.tsx. Every /studio/* route nests under this; the loader
 * here is what actually enforces standalone authentication (mirrors
 * app.tsx calling requireAdminContext for the Shopify side).
 *
 * The sidebar's conversation history reuses
 * services/creative-studio/workspace-library.server.ts's
 * `listWorkspaceConversations` — no thumbnails here (a lightweight title
 * list, not a gallery; see studio.creations.tsx for the thumbnail-rich
 * view), computed once per navigation into /studio/* the same way this
 * loader always has been.
 */
import type { HeadersFunction, LinksFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, Outlet, useLoaderData, useLocation, useParams } from "react-router";
import { requireWorkspaceContext } from "../../lib/auth/standalone-session.server";
import { listWorkspaceConversations } from "../../services/creative-studio/workspace-library.server";
import prisma from "../../db/client.server";
import { Logo } from "../components/logo";
import studioStylesHref from "../styles/studio.css?url";

export const links: LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&display=swap" },
  { rel: "stylesheet", href: studioStylesHref },
  { rel: "icon", type: "image/svg+xml", href: "/favicon-studio.svg" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { context, userId, workspaceId } = await requireWorkspaceContext(request);
  const [user, workspace, conversations] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } }),
    prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true } }),
    listWorkspaceConversations(context, { limit: 30, withThumbnails: false }),
  ]);
  return { email: user.email, workspaceName: workspace.name, conversations };
};

export default function StudioShell() {
  const { email, workspaceName, conversations } = useLoaderData<typeof loader>();
  const params = useParams();
  const location = useLocation();
  const activeSessionId = params.sessionId;
  const initial = email.trim().charAt(0).toUpperCase() || "?";

  return (
    <div className="studio-root studio-shell">
      <aside className="studio-sidebar">
        <Link to="/studio" className="studio-sidebar-top" aria-label="AI Imageshoot — new conversation">
          <Logo variant="full" size={20} />
        </Link>

        <Link to="/studio" className="studio-new-btn">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          New conversation
        </Link>

        <p className="studio-sidebar-label">Conversations</p>
        <div className="studio-conv-list">
          {conversations.length === 0 ? (
            <p className="studio-conv-empty">Your conversations will appear here once you start creating.</p>
          ) : (
            conversations.map((conversation) => (
              <Link
                key={conversation.id}
                to={`/studio/c/${conversation.id}`}
                className="studio-conv-item"
                data-active={conversation.id === activeSessionId}
                title={conversation.title}
              >
                {conversation.title}
              </Link>
            ))
          )}
        </div>

        <nav className="studio-sidebar-links">
          <Link to="/studio/creations" data-active={location.pathname === "/studio/creations" || undefined}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
              <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
              <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
              <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
            </svg>
            Creations
          </Link>
        </nav>

        <div className="studio-sidebar-footer">
          <Link to="/studio/account" className="studio-account-chip" title={email}>
            <span className="studio-avatar" aria-hidden="true">
              {initial}
            </span>
            <span>
              <span className="studio-account-email">{workspaceName}</span>
            </span>
          </Link>
          <Form method="post" action="/logout">
            <button type="submit" className="studio-logout-btn" title={`Log out of ${email}`}>
              Log out
            </button>
          </Form>
        </div>
      </aside>
      <main className="studio-main">
        <Outlet />
      </main>
    </div>
  );
}

export const headers: HeadersFunction = () => ({});
