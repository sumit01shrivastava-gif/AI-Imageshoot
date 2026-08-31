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
import { useEffect, useState } from "react";
import type { HeadersFunction, LinksFunction, LoaderFunctionArgs, ShouldRevalidateFunction } from "react-router";
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

  // Mobile only (desktop's sidebar is always visible — see studio.css's
  // media query, which is the only place `data-open`/`data-nav-open`
  // below actually do anything). A real off-canvas drawer, not the
  // previous horizontally-scrolling top bar that left account/logout
  // reachable only by scrolling sideways past everything else.
  const [isNavOpen, setIsNavOpen] = useState(false);
  // Closes the drawer on navigation — adjusted DURING render (React's
  // documented pattern for "reset state when a prop changes"), not
  // inside a useEffect, so this never triggers the cascading-render
  // set-state-in-effect issue app/routes/studio.c.$sessionId.tsx hit
  // earlier. Bails out (no infinite loop) the moment prevPathname
  // catches up to location.pathname.
  const [prevPathname, setPrevPathname] = useState(location.pathname);
  if (location.pathname !== prevPathname) {
    setPrevPathname(location.pathname);
    setIsNavOpen(false);
  }

  useEffect(() => {
    if (!isNavOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsNavOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isNavOpen]);

  return (
    <div className="studio-root studio-shell" data-nav-open={isNavOpen}>
      <div className="studio-mobile-topbar">
        <Link to="/studio" aria-label="AI Imageshoot — new conversation">
          <Logo variant="full" size={19} />
        </Link>
        <button
          type="button"
          className="studio-mobile-menu-btn"
          aria-label={isNavOpen ? "Close menu" : "Open menu"}
          aria-expanded={isNavOpen}
          onClick={() => setIsNavOpen((open) => !open)}
        >
          {isNavOpen ? (
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          )}
        </button>
      </div>

      {isNavOpen && <button type="button" className="studio-nav-backdrop" aria-label="Close menu" onClick={() => setIsNavOpen(false)} />}

      <aside className="studio-sidebar" data-open={isNavOpen}>
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

/** A child conversation's status poll has its own authenticated action
 * response; reloading the workspace history every second would delay it. */
export const shouldRevalidate: ShouldRevalidateFunction = ({ formData, defaultShouldRevalidate }) =>
  formData?.get("intent") === "poll-generation-status" ? false : defaultShouldRevalidate;
