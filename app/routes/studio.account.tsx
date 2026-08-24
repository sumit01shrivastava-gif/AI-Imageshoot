/**
 * Standalone account page — kept minimal per this phase's scope (no
 * settings dashboard; see CLAUDE.md's "do not overbuild" instruction),
 * just redesigned to match the new studio look.
 */
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { requireWorkspaceContext } from "../../lib/auth/standalone-session.server";
import prisma from "../../db/client.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { userId, workspaceId } = await requireWorkspaceContext(request);
  const [user, workspace] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, createdAt: true } }),
    prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true, createdAt: true } }),
  ]);
  return { email: user.email, memberSince: user.createdAt, workspaceName: workspace.name };
};

export default function StudioAccount() {
  const { email, memberSince, workspaceName } = useLoaderData<typeof loader>();

  return (
    <div className="studio-page">
      <h1 className="studio-page-heading">Account</h1>
      <p className="studio-page-sub">Your login and workspace.</p>
      <dl className="studio-dl">
        <dt>Email</dt>
        <dd>{email}</dd>
        <dt>Workspace</dt>
        <dd>{workspaceName}</dd>
        <dt>Member since</dt>
        <dd>{new Date(memberSince).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}</dd>
      </dl>
    </div>
  );
}
