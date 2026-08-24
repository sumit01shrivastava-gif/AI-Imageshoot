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
    <div className="account">
      <h1>Account</h1>
      <dl>
        <dt>Email</dt>
        <dd>{email}</dd>
        <dt>Workspace</dt>
        <dd>{workspaceName}</dd>
        <dt>Member since</dt>
        <dd>{new Date(memberSince).toLocaleDateString()}</dd>
      </dl>
      <style>{`
        .account h1 { font-size: 24px; margin: 0 0 24px; }
        .account dl { display: grid; grid-template-columns: 140px 1fr; gap: 12px 16px; max-width: 460px; }
        .account dt { color: #7c877f; font-size: 13px; }
        .account dd { margin: 0; font-size: 14.5px; }
      `}</style>
    </div>
  );
}
