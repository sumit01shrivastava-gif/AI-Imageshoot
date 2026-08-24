/**
 * The standalone studio's landing/composer screen — "start a new
 * conversation." Creates a real, product-less `CreativeSession` (see
 * prisma/schema.prisma's CreativeSession.productId comment) and sends
 * the first message through the SAME `sendCreativeMessage` pipeline
 * every Shopify-context Creative Studio session uses
 * (services/creative-studio/session.server.ts) — no second generation
 * engine. Redirects into the real conversation view
 * (studio.c.$sessionId.tsx) once the first `GenerationJob` is enqueued;
 * the actual generation result is rendered there, polled from the real
 * queue/worker, never faked here.
 */
import { useRef } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useFetcher } from "react-router";
import { requireWorkspaceContext } from "../../lib/auth/standalone-session.server";
import {
  startCreativeSession,
  sendCreativeMessage,
  EmptyMessageError,
  InsufficientCreditsError,
  PlanLimitExceededError,
} from "../../services/creative-studio/session.server";
import { logger } from "../../lib/logging/logger.server";
import { Composer, type ComposerHandle } from "../components/composer";

const GENERIC_ERROR = "Couldn't start that conversation right now. Please try again.";

const EXAMPLE_PROMPTS = [
  "Create a premium product campaign image for this shoe.",
  "Turn this product photo into a luxury studio advertisement.",
  "Create a 4:5 Instagram campaign image using this product.",
  "Create a website hero banner for this collection.",
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireWorkspaceContext(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { context } = await requireWorkspaceContext(request);
  const formData = await request.formData();
  const message = String(formData.get("message") ?? "").trim();
  const files = formData.getAll("images").filter((f): f is File => f instanceof File && f.size > 0);

  if (message.length === 0 && files.length === 0) {
    return { ok: false as const, error: "Describe what you want, or attach an image to start from." };
  }

  try {
    const created = await startCreativeSession(context, {});
    const referenceImages = await Promise.all(
      files.map(async (file) => ({ data: new Uint8Array(await file.arrayBuffer()), contentType: file.type })),
    );
    // An image-only first message still needs SOME instruction — a
    // real, sensible default, not a fabricated response (the actual
    // generation still runs through the real pipeline below).
    const effectiveMessage = message.length > 0 ? message : "Create a clean, professional product photo from this image.";
    await sendCreativeMessage(context, created.id, effectiveMessage, { referenceImages });
    return redirect(`/studio/c/${created.id}`);
  } catch (error) {
    if (error instanceof EmptyMessageError) {
      return { ok: false as const, error: error.message };
    }
    if (error instanceof InsufficientCreditsError || error instanceof PlanLimitExceededError) {
      return { ok: false as const, error: error.message };
    }
    logger.error("studio.new_conversation_failed", {
      shop: context.shop,
      detail: error instanceof Error ? error.message : "unknown error",
    });
    return { ok: false as const, error: GENERIC_ERROR };
  }
};

export default function StudioNewConversation() {
  const fetcher = useFetcher<typeof action>();
  const composerRef = useRef<ComposerHandle>(null);
  const isSending = fetcher.state !== "idle";
  const error = fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;

  function handleSubmit(message: string, files: File[]) {
    const formData = new FormData();
    formData.set("message", message);
    files.forEach((file) => formData.append("images", file));
    fetcher.submit(formData, { method: "POST", encType: "multipart/form-data" });
  }

  return (
    <div className="studio-hero">
      <h1 className="studio-hero-heading">What do you want to create?</h1>
      <p className="studio-hero-sub">Describe the image you want, or attach a photo — AI Imageshoot handles the rest.</p>

      <div className="studio-example-row">
        {EXAMPLE_PROMPTS.map((prompt) => (
          <button key={prompt} type="button" className="studio-example-chip" onClick={() => composerRef.current?.fill(prompt)}>
            {prompt}
          </button>
        ))}
      </div>

      <div className="studio-composer-wrap">
        <Composer ref={composerRef} disabled={isSending} busy={isSending} onSubmit={handleSubmit} />
        {error && <p className="studio-composer-error">{error}</p>}
        <p className="studio-composer-hint">Every conversation is saved, and every version stays available.</p>
      </div>
    </div>
  );
}
