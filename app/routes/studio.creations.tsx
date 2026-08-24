/**
 * Standalone creations gallery — reuses services/assets/asset-library.server.ts
 * completely unmodified (it's already generic over any AuthContext.shop).
 * Currently always empty for a standalone workspace, honestly: nothing can
 * create a GenerationResult/ProcessingResult/StoreVisualResult for a
 * workspace tenantKey yet (see studio._index.tsx's doc comment) — this
 * page is real and will show real results the moment that following
 * phase lands, with zero changes needed here.
 */
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { requireWorkspaceContext } from "../../lib/auth/standalone-session.server";
import { listAssetLibrary } from "../../services/assets/asset-library.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { context } = await requireWorkspaceContext(request);
  const page = await listAssetLibrary(context, {}, 1, 24);
  return { items: page.items };
};

export default function StudioCreations() {
  const { items } = useLoaderData<typeof loader>();

  return (
    <div className="creations">
      <h1>Creations</h1>
      <p className="creations-sub">Everything you&rsquo;ve generated in this workspace.</p>

      {items.length === 0 ? (
        <div className="creations-empty">
          <p>Nothing generated yet.</p>
        </div>
      ) : (
        <div className="creations-grid">
          {items.map((item) =>
            item.url ? (
              <a key={item.id} href={item.url} target="_blank" rel="noreferrer" className="creations-card">
                <img src={item.url} alt={item.productTitle ?? "Generated image"} />
              </a>
            ) : null,
          )}
        </div>
      )}
      <style>{`
        .creations h1 { font-size: 24px; margin: 0 0 6px; }
        .creations-sub { color: #5b655f; font-size: 14.5px; margin: 0 0 28px; }
        .creations-empty { border: 1px dashed #c7cdc8; border-radius: 12px; padding: 40px; text-align: center; color: #7c877f; font-size: 14px; }
        .creations-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 14px; }
        .creations-card { display: block; border-radius: 8px; overflow: hidden; border: 1px solid #dde2de; aspect-ratio: 1; }
        .creations-card img { width: 100%; height: 100%; object-fit: cover; display: block; }
      `}</style>
    </div>
  );
}
