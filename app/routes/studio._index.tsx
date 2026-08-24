/**
 * Standalone dashboard — the authenticated landing page inside the new
 * workspace shell. Deliberately honest about what's wired up: this phase
 * ships real identity/workspace/session infrastructure; conversational
 * generation from an uploaded image (no Shopify product) is real,
 * separate follow-up work — see docs/roadmap.md "Two experiences, one
 * core", Phase 1's noted scope boundary. Nothing here fakes a working
 * "start conversation" action.
 */
import type { LoaderFunctionArgs } from "react-router";
import { requireWorkspaceContext } from "../../lib/auth/standalone-session.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireWorkspaceContext(request);
  return null;
};

export default function StudioDashboard() {
  return (
    <div className="dash">
      <h1>Your workspace</h1>
      <p className="dash-sub">You&rsquo;re signed in and your workspace is ready.</p>

      <div className="dash-empty">
        <div className="dash-empty-icon">✨</div>
        <p className="dash-empty-title">Conversational creation is coming here next</p>
        <p className="dash-empty-body">
          This workspace already shares the same AI generation engine, storage, and credit system as the
          Shopify app. The next piece connects it: uploading a photo and starting a conversation right
          here, no Shopify store required.
        </p>
      </div>
      <style>{`
        .dash h1 { font-size: 24px; margin: 0 0 6px; }
        .dash-sub { color: #5b655f; font-size: 14.5px; margin: 0 0 32px; }
        .dash-empty { border: 1px dashed #c7cdc8; border-radius: 12px; padding: 48px 32px; text-align: center; max-width: 460px; }
        .dash-empty-icon { font-size: 28px; margin-bottom: 12px; }
        .dash-empty-title { font-weight: 650; font-size: 15px; margin: 0 0 8px; }
        .dash-empty-body { color: #5b655f; font-size: 13.5px; line-height: 1.6; margin: 0; }
      `}</style>
    </div>
  );
}
