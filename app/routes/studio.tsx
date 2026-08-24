/**
 * Standalone application shell layout — the non-Shopify counterpart to
 * app/routes/app.tsx. Every /studio/* route nests under this; the loader
 * here is what actually enforces standalone authentication (mirrors
 * app.tsx calling requireAdminContext for the Shopify side).
 */
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, Outlet, useLoaderData } from "react-router";
import { requireWorkspaceContext } from "../../lib/auth/standalone-session.server";
import prisma from "../../db/client.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { userId, workspaceId } = await requireWorkspaceContext(request);
  const [user, workspace] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } }),
    prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true } }),
  ]);
  return { email: user.email, workspaceName: workspace.name };
};

export default function StudioShell() {
  const { email, workspaceName } = useLoaderData<typeof loader>();

  return (
    <div className="studio-shell">
      <aside className="studio-nav">
        <Link to="/studio" className="studio-brand">
          AI Imageshoot
        </Link>
        <div className="studio-workspace">{workspaceName}</div>
        <nav className="studio-nav-links">
          <Link to="/studio">New conversation</Link>
          <Link to="/studio/creations">Creations</Link>
          <Link to="/studio/account">Account</Link>
        </nav>
        <div className="studio-nav-footer">
          <span className="studio-email">{email}</span>
          <Form method="post" action="/logout">
            <button type="submit" className="studio-logout">
              Log out
            </button>
          </Form>
        </div>
      </aside>
      <main className="studio-main">
        <Outlet />
      </main>
      <style>{`
        .studio-shell { display: grid; grid-template-columns: 240px 1fr; min-height: 100vh; background: #f7f8f6; font-family: "IBM Plex Sans", -apple-system, sans-serif; color: #161a1f; }
        .studio-nav { display: flex; flex-direction: column; border-right: 1px solid #dde2de; padding: 20px 16px; background: #fff; }
        .studio-brand { font-weight: 700; font-size: 15px; text-decoration: none; color: #161a1f; margin-bottom: 4px; }
        .studio-workspace { font-size: 12.5px; color: #7c877f; margin-bottom: 24px; }
        .studio-nav-links { display: flex; flex-direction: column; gap: 2px; flex: 1; }
        .studio-nav-links a { text-decoration: none; color: #3a423e; font-size: 14px; padding: 9px 10px; border-radius: 7px; }
        .studio-nav-links a:hover { background: #f0f2ef; }
        .studio-nav-footer { border-top: 1px solid #e4e8e4; padding-top: 14px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .studio-email { font-size: 12px; color: #7c877f; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .studio-logout { background: none; border: none; color: #c1531f; font-size: 12.5px; font-weight: 600; cursor: pointer; padding: 0; }
        .studio-main { padding: 40px 48px; overflow-y: auto; }
        @media (max-width: 720px) {
          .studio-shell { grid-template-columns: 1fr; }
          .studio-nav { flex-direction: row; align-items: center; flex-wrap: wrap; border-right: none; border-bottom: 1px solid #dde2de; }
          .studio-nav-links { flex-direction: row; }
          .studio-main { padding: 24px 20px; }
        }
      `}</style>
    </div>
  );
}

export const headers: HeadersFunction = () => ({});
