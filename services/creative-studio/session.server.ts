/**
 * Creative Studio — service entry point used by routes. Orchestrates the
 * full conversational flow: parse intent → build creative context →
 * check/reserve entitlement → build a `GenerationPlan` → create + enqueue
 * a `GenerationJob` (via services/generation/request-generation.server.ts's
 * shared `createAndEnqueueGenerationJob` primitive) → persist the
 * conversation turn. See docs/creative-studio.md "Architecture".
 *
 * Every entry point takes an `AuthContext` and re-verifies shop
 * ownership — never trusts a client-supplied session/product/result id
 * (see CLAUDE.md "Security requirements").
 */
import type { ReviewStatus } from "@prisma/client";
import type { AuthContext } from "../../lib/auth/types";
import { logger } from "../../lib/logging/logger.server";
import { TenantMismatchError } from "../../lib/auth/tenant.server";
import { findProductForShop } from "../../db/repositories/shopify-product.repository";
import { getProductIntelligence } from "../intelligence/product-intelligence.server";
import {
  getCreativeSession,
  createCreativeSession,
  setCurrentResult,
  listCreativeSessionsForProduct,
  deleteEmptyCreativeSession,
  type CreativeSessionRow,
  type CreativeSourceType,
} from "../../db/repositories/creative-session.repository";
import {
  createCreativeMessage,
  listCreativeMessages,
  type CreativeMessageRow,
} from "../../db/repositories/creative-message.repository";
import {
  listGenerationJobsForCreativeSession,
  getGenerationResultForPublishing,
  getGenerationPlanForResult,
  type GenerationJobRow,
} from "../../db/repositories/generation-job.repository";
import { getProcessingResultForPublishing } from "../../db/repositories/processing-job.repository";
import { getStoreVisualResultForPublishing } from "../../db/repositories/store-visual-job.repository";
import { resignResultUrls, getConfiguredStorageProvider } from "../../lib/storage";
import { getConfiguredIntentParser } from "./provider.server";
import { parseParsedIntent, type ParsedIntent } from "./intent-schema";
import { buildCreativeContext, resolveTargetResult, type CreativeContext } from "./creative-context";
import { buildCreativeGenerationPlan, buildStandaloneCreativeGenerationPlan, ProductNotAnalyzedError, MissingSourceImagesError } from "./plan-builder";
import { createAndEnqueueGenerationJob, ProductNotFoundError, reviewGenerationResult, GenerationResultNotFoundError } from "../generation/request-generation.server";
import { parseGenerationPlan, type GenerationPlan } from "../generation/schema";
import { checkGenerationEntitlement, reserveGenerationCredits, InsufficientCreditsError, PlanLimitExceededError, type EntitlementCheck } from "../usage/entitlement.server";
import { getCreditCost } from "../usage/credit-costs";
import { uploadReferenceImages, type UploadedReferenceImageInput } from "./reference-images.server";
import {
  applyLearnedDefaults,
  recordCorrectionSignal,
  recordRegenerateSignal,
  recordExplicitFeedback,
  recordReviewSignal,
  contextForIntent,
  type LearnableCreativeFields,
  type PreferenceContext,
} from "./personalization.server";

export { ProductNotFoundError, ProductNotAnalyzedError, MissingSourceImagesError, GenerationResultNotFoundError, InsufficientCreditsError, PlanLimitExceededError };

/** Deliberately the same "not found" shape a missing/foreign-shop
 * session gets — see ProductNotFoundError's own doc comment
 * (existence-oracle prevention), applied here identically. */
export class CreativeSessionNotFoundError extends Error {
  constructor() {
    super("Creative session not found");
    this.name = "CreativeSessionNotFoundError";
  }
}

export class EmptyMessageError extends Error {
  constructor() {
    super("Message cannot be empty.");
    this.name = "EmptyMessageError";
  }
}

export interface StartCreativeSessionInput {
  /** A Shopify product to ground this session in — omit for a standalone
   * (no Shopify product) session, e.g. one started from an uploaded
   * image in a workspace with no Shopify connection. */
  productId?: string;
  sourceType?: CreativeSourceType;
  /** A specific GenerationResult/ProcessingResult/StoreVisualResult id
   * this session continues from ("Continue editing") — required when
   * `sourceType` isn't `"PRODUCT_IMAGE"`. Not verified against the
   * result's own review status here (a session can be opened from any
   * existing result, approved or not — publishing, not session
   * creation, is where approval actually matters). */
  sourceResultId?: string;
  /** A specific `ShopifyProductMedia` id to start from — only meaningful
   * for `sourceType: "PRODUCT_IMAGE"`; omitted defaults to every one of
   * the product's current images (see plan-builder.ts's fallback). */
  sourceMediaId?: string;
}

/** Opens a new Creative Session for one product. Deliberately does NOT
 * create one session per message (see prisma/schema.prisma's
 * CreativeSession model comment) — this is called once, from a "Create
 * with AI" / "Edit with AI" / "Continue editing" / "Open in Creative
 * Studio" entry point (see docs/creative-studio.md "Routing"); every
 * subsequent instruction goes through `sendCreativeMessage` against the
 * SAME session id. */
export async function startCreativeSession(context: AuthContext, input: StartCreativeSessionInput): Promise<{ id: string }> {
  // `input.productId` omitted -> a standalone session with no Shopify
  // product at all (see StartCreativeSessionInput's doc comment). Every
  // existing caller (product detail page, assets library, store visual
  // detail page) always passes a real productId today — this branch is
  // new surface, not a behavior change for any of them.
  const productId = input.productId ? (await loadOwnedProduct(context, input.productId)).id : null;

  return createCreativeSession({
    shop: context.shop,
    productId,
    sourceType: input.sourceType ?? "PRODUCT_IMAGE",
    sourceResultId: input.sourceResultId ?? null,
    sourceMediaId: input.sourceMediaId ?? null,
  });
}

/** Rollback for a "start a new conversation" flow whose session was
 * created but whose immediately-following first message failed (see
 * app/routes/studio._index.tsx) — deletes the now-pointless empty
 * session so it never shows up as a permanent, untitled "New
 * conversation" row. A no-op (never throws) if the session already
 * picked up a message, or doesn't belong to this shop — see
 * `deleteEmptyCreativeSession`'s own doc comment. */
export async function abandonEmptyCreativeSession(context: AuthContext, sessionId: string): Promise<void> {
  await deleteEmptyCreativeSession(context.shop, sessionId);
}

async function loadOwnedProduct(context: AuthContext, productId: string) {
  try {
    const product = await findProductForShop(context, productId);
    if (!product) throw new ProductNotFoundError();
    return product;
  } catch (error) {
    if (error instanceof TenantMismatchError) throw new ProductNotFoundError();
    throw error;
  }
}

export interface CreativeSessionDetail {
  session: CreativeSessionRow;
  messages: CreativeMessageRow[];
  jobs: GenerationJobRow[];
  creativeContext: CreativeContext;
  entitlement: EntitlementCheck;
  /** Safe loader observability only — no prompt, URL, or attachment data. */
  telemetry: {
    resultSigningMs: number;
    resultSigningCount: number;
    historicalResultCount: number;
  };
}

/** Everything the Creative Studio route's loader needs in one call —
 * session, full message history, every generation job this session has
 * produced (most-recent-first — the "grid of generated variations" the
 * UI renders is `jobs[0].results`), the derived creative context, and
 * the current entitlement snapshot (so the UI can show available
 * credits before the merchant even sends a message — see Part 9). */
export async function getCreativeSessionDetail(context: AuthContext, sessionId: string): Promise<CreativeSessionDetail> {
  const session = await getCreativeSession(context, sessionId);
  if (!session) throw new CreativeSessionNotFoundError();

  const [messages, jobsRaw, entitlement] = await Promise.all([
    listCreativeMessages(context.shop, session.id),
    listGenerationJobsForCreativeSession(context.shop, session.id),
    checkGenerationEntitlement(context, 1),
  ]);

  const resultSigningStartedAt = Date.now();
  const historicalResultCount = jobsRaw.reduce((count, job) => count + job.results.length, 0);
  const jobs = await Promise.all(jobsRaw.map(async (job) => ({ ...job, results: await resignResultUrls(job.results) })));
  const resultSigningMs = Date.now() - resultSigningStartedAt;

  const creativeContext = buildSessionCreativeContext(session, jobs, messages);

  return {
    session,
    messages,
    jobs,
    creativeContext,
    entitlement,
    telemetry: {
      resultSigningMs,
      resultSigningCount: historicalResultCount,
      historicalResultCount,
    },
  };
}

/**
 * Validates a browser timing event without calling `getCreativeSessionDetail`.
 * The latter deliberately fresh-signs every historical result for rendering;
 * using it merely to validate telemetry would make the telemetry endpoint
 * itself distort the loader/revalidation timing it is meant to measure.
 */
export async function canRecordCreativeStudioTelemetry(
  context: AuthContext,
  sessionId: string,
  generationJobId?: string | null,
  resultId?: string | null,
): Promise<boolean> {
  const session = await getCreativeSession(context, sessionId);
  if (!session) return false;
  if (!generationJobId) return true;

  const jobs = await listGenerationJobsForCreativeSession(context.shop, session.id);
  const job = jobs.find((candidate) => candidate.id === generationJobId);
  if (!job) return false;
  return !resultId || job.results.some((result) => result.id === resultId);
}

function buildSessionCreativeContext(
  session: CreativeSessionRow,
  jobs: GenerationJobRow[],
  messages: CreativeMessageRow[],
): CreativeContext {
  const latestJob = jobs[0] ?? null;
  const currentResultRow = session.currentResultId
    ? jobs.flatMap((job) => job.results.map((result) => ({ result, job }))).find(({ result }) => result.id === session.currentResultId)
    : undefined;

  let currentResultCreativeIntent: GenerationPlan["creativeIntent"] = null;
  if (currentResultRow && currentResultRow.job.type === "CREATIVE_STUDIO") {
    try {
      currentResultCreativeIntent = parseGenerationPlan(currentResultRow.job.plan).creativeIntent;
    } catch {
      // A malformed/legacy plan shouldn't break context building — just
      // means no "active" creative state to carry forward this turn.
      currentResultCreativeIntent = null;
    }
  }

  return buildCreativeContext({
    currentResult: currentResultRow ? { id: currentResultRow.result.id, url: currentResultRow.result.url } : null,
    currentResultCreativeIntent,
    latestJobResults: latestJob ? latestJob.results.map((r) => ({ id: r.id, url: r.url })) : [],
    recentInstructions: messages.filter((m) => m.role === "USER").map((m) => m.content),
  });
}

/**
 * Resolves the starting image for a session opened via "Continue
 * editing" (`sourceType !== "PRODUCT_IMAGE"`) — reuses each domain's own
 * `get*ResultForPublishing` accessor (a shop-scoped, tenant-safe lookup
 * that already exists for services/publishing/) rather than writing a
 * near-duplicate one here; it happens to return exactly what's needed
 * (`storageKey`, checked for shop ownership). Returns `null` once this
 * session has produced its own result (there's a real current result to
 * use instead by then) or if the referenced result has since vanished
 * (shop redaction, product deletion) — never throws; a session that
 * loses its starting point mid-conversation should just fall back to
 * TEXT_TO_IMAGE, not break.
 */
async function resolveSessionStartingImage(shop: string, session: CreativeSessionRow): Promise<string | null> {
  if (session.sourceType === "PRODUCT_IMAGE" || !session.sourceResultId || session.currentResultId) {
    return null;
  }

  let storageKey: string | null = null;
  if (session.sourceType === "GENERATION_RESULT") {
    storageKey = (await getGenerationResultForPublishing(shop, session.sourceResultId))?.storageKey ?? null;
  } else if (session.sourceType === "PROCESSING_RESULT") {
    storageKey = (await getProcessingResultForPublishing(shop, session.sourceResultId))?.storageKey ?? null;
  } else if (session.sourceType === "STORE_VISUAL_RESULT") {
    storageKey = (await getStoreVisualResultForPublishing(shop, session.sourceResultId))?.storageKey ?? null;
  }
  if (!storageKey) return null;

  return getConfiguredStorageProvider().getSignedUrl({ key: storageKey, expiresInSeconds: 3600, operation: "get" });
}

export interface SendCreativeMessageResult {
  ok: true;
  generationJobId: string;
  parsedIntent: ParsedIntent;
}

export interface SendCreativeMessageOptions {
  /** Raw bytes for any images the merchant attached to THIS message —
   * only meaningful for a standalone (no Shopify product) session; a
   * Shopify-context session already has real product media to ground
   * against and ignores this. Uploaded (via
   * reference-images.server.ts's `uploadReferenceImages`) BEFORE the
   * plan is built, so their durable URLs can be included in it. */
  referenceImages?: UploadedReferenceImageInput[];
  /** The signed-in standalone user, when one exists — see
   * services/creative-studio/personalization.server.ts's module doc
   * comment for why this is `undefined`/`null` (never a fabricated
   * value) for every Shopify-context call site (Shopify has no `User`
   * concept at all) and real for every standalone `/studio/*` route
   * (already resolved there via `requireWorkspaceContext`). Gates BOTH
   * reading personalized defaults and writing new learning signals —
   * personalization is entirely inert without it. */
  userId?: string | null;
}

/**
 * The core conversational entry point — one merchant message in, one new
 * `GenerationJob` enqueued (never overwriting a prior result; see
 * docs/creative-studio.md "Image-to-image flow"). Throws
 * `InsufficientCreditsError`/`ProductNotAnalyzedError`/
 * `MissingSourceImagesError`/`EmptyMessageError` for the merchant-facing
 * preconditions a route action maps to safe messages — see Part 11.
 *
 * Handles BOTH session contexts through this single function, branching
 * only where they're genuinely different (product/intelligence loading,
 * which plan-builder function runs) — everything else (context building,
 * intent parsing, target-result resolution, credit gating, job creation,
 * message persistence) is the exact same code/pipeline for both, per
 * CLAUDE.md's "the generation engine is not duplicated" rule. A
 * Shopify-context session (`session.productId` set) NEVER calls
 * `findProductForShop`/`getProductIntelligence` for a standalone session,
 * and vice versa — see the ternary below.
 */
export async function sendCreativeMessage(
  context: AuthContext,
  sessionId: string,
  message: string,
  options: SendCreativeMessageOptions = {},
): Promise<SendCreativeMessageResult> {
  const requestStartedAt = Date.now();
  const trimmed = message.trim();
  if (trimmed.length === 0) throw new EmptyMessageError();

  const session = await getCreativeSession(context, sessionId);
  if (!session) throw new CreativeSessionNotFoundError();

  // Product lookup, compact session history, and a possible foreign starting
  // image are independent reads. Run them together; Product Intelligence
  // correctly remains after the owned product is known. This preserves one
  // semantic planning pass while removing avoidable request serial time.
  const contextLoadStartedAt = Date.now();
  const [product, history, startingImageUrl] = await Promise.all([
    session.productId ? loadOwnedProduct(context, session.productId) : Promise.resolve(null),
    Promise.all([
      listGenerationJobsForCreativeSession(context.shop, session.id),
      listCreativeMessages(context.shop, session.id),
    ]),
    resolveSessionStartingImage(context.shop, session),
  ]);
  const [jobsRaw, messages] = history;
  const jobs = await Promise.all(jobsRaw.map(async (job) => ({ ...job, results: await resignResultUrls(job.results) })));
  const creativeContext = buildSessionCreativeContext(session, jobs, messages);
  const contextLoadMs = Date.now() - contextLoadStartedAt;
  const intelligenceStartedAt = Date.now();
  const intelligence = product ? await getProductIntelligence(context, product.id) : null;
  const productIntelligenceMs = Date.now() - intelligenceStartedAt;

  // A session opened via "Continue editing" (Part 13) has no result of
  // its OWN yet on its first turn — its starting point is a foreign
  // result outside this session's own jobs (see `session.sourceResultId`).
  // Resolve that BEFORE parsing, since it changes how many "candidates"
  // genuinely exist to interpret a follow-up against.
  const effectiveCandidateCount = creativeContext.candidateResults.length > 0 ? creativeContext.candidateResults.length : startingImageUrl ? 1 : 0;

  // A standalone session has no ShopifyProductMedia to ground against —
  // any image attached to THIS turn is uploaded here, through the same
  // StorageProvider abstraction every generated result already uses (see
  // reference-images.server.ts). Only ever runs for a standalone session
  // (`!product`); a Shopify-context session ignores `options.referenceImages`
  // entirely (it always has real product media instead). Moved ahead of
  // intent parsing (it used to run after) specifically so these URLs can
  // be offered to the parser below — see `referenceImageUrlsForParsing`.
  const uploadedReferenceImageUrls = product ? [] : await uploadReferenceImages(context.shop, session.id, options.referenceImages ?? []);

  // The images offered to the INTENT PARSER (see
  // services/ai/types.ts's `ParseIntentInput.referenceImageUrls` doc
  // comment) — deliberately the CURRENTLY-selected result/starting image,
  // not whatever an ordinal reference in THIS message might resolve to
  // (`resolveTargetResult` below needs the parser's own output —
  // specifically `targetResultReference` — to run at all, so it cannot
  // run before parsing). This covers the overwhelming majority of real
  // turns (an ordinary follow-up edits forward from the current result,
  // or the merchant just uploaded a new image this turn); the one edge
  // case this doesn't perfectly cover — "use the SECOND one, and also
  // make her do yoga" — 	shows the parser the current result rather
  // than the explicitly-referenced second one. A known, deliberate
  // scope decision (a two-pass parse would resolve it exactly, at
  // real added latency/cost), not silently unhandled.
  const referenceImageUrlsForParsing = [
    ...uploadedReferenceImageUrls,
    ...(creativeContext.currentImageUrl ? [creativeContext.currentImageUrl] : startingImageUrl ? [startingImageUrl] : []),
  ];

  // Parse the raw message → structured intent. See
  // services/ai/heuristic-intent-parser.ts's doc comment for why this
  // always succeeds today (a real, non-AI default, not gated to tests).
  // Fully generic — intent parsing never depends on a Shopify product.
  const parser = getConfiguredIntentParser();
  const intentParsingStartedAt = Date.now();
  const rawOutput = await parser.parseIntent({
    message: trimmed,
    creativeContext: creativeContext as unknown as Record<string, unknown>,
    candidateResultCount: effectiveCandidateCount,
    referenceImageUrls: referenceImageUrlsForParsing,
  });
  const parsedIntent = parseParsedIntent(rawOutput);
  const intentParseMs = Date.now() - intentParsingStartedAt;

  // Resolve an explicit "use the second one"-style reference against the
  // session's actual candidate results — see creative-context.ts's
  // `resolveTargetResult`. When it resolves, that becomes both the image
  // this turn edits forward from AND the session's new current result
  // (the merchant explicitly picked it).
  const resolvedTargetId = resolveTargetResult(creativeContext, parsedIntent.targetResultReference);
  let editSourceResult = creativeContext.candidateResults.find((r) => r.id === creativeContext.selectedResultId) ?? null;
  if (resolvedTargetId) {
    const resolved = creativeContext.candidateResults.find((r) => r.id === resolvedTargetId);
    if (resolved) editSourceResult = resolved;
  }

  const previousResultUrl = editSourceResult?.url ?? startingImageUrl;

  // The parser may have guessed TEXT_TO_IMAGE (nothing in THIS session's
  // own history yet), but a "Continue editing" session — or a standalone
  // turn with a freshly uploaded image — genuinely does have something to
  // edit forward from; correct that here rather than inside the parser,
  // which has no notion of a foreign starting result or this turn's own
  // upload.
  const hasImageToGroundThisTurn = Boolean(previousResultUrl) || uploadedReferenceImageUrls.length > 0;
  const modeCorrectedIntent: ParsedIntent =
    parsedIntent.mode === "TEXT_TO_IMAGE" && hasImageToGroundThisTurn ? { ...parsedIntent, mode: "IMAGE_TO_IMAGE" } : parsedIntent;

  // Personalization (Layer 2 of the creative-intelligence model — see
  // personalization.server.ts's module doc comment) — entirely inert
  // without a real signed-in standalone user (Shopify calls never pass
  // `userId`; see SendCreativeMessageOptions.userId's doc comment).
  //
  // Order matters: the CORRECTION signal compares what this turn
  // actually specified against what was active before — recorded
  // BEFORE learned defaults are applied, so a filled-in default is
  // never mistaken for something the merchant explicitly changed. The
  // learned defaults are applied AFTER, and only ever fill a field this
  // turn left null — never touching one the merchant specified (see
  // `applyLearnedDefaults`'s own "explicit always wins" contract).
  if (options.userId && creativeContext.hasCurrentResult) {
    await recordCorrectionSignal(
      options.userId,
      {
        style: creativeContext.activeStyle,
        lighting: creativeContext.activeLighting,
        composition: creativeContext.activeComposition,
        camera: creativeContext.activeCamera,
        colorDirection: creativeContext.activeColorDirection,
        depthOfField: creativeContext.activeDepthOfField,
      },
      {
        style: modeCorrectedIntent.style,
        lighting: modeCorrectedIntent.lighting,
        composition: modeCorrectedIntent.composition,
        camera: modeCorrectedIntent.camera,
        colorDirection: modeCorrectedIntent.colorDirection,
        depthOfField: modeCorrectedIntent.depthOfField,
      },
      // THIS turn's own context bucket — see personalization.server.ts's
      // "Context-aware weighting": a correction is evidence about what
      // this user wants for requests LIKE the one they're making now,
      // not a global, request-type-blind preference.
      contextForIntent(modeCorrectedIntent.intent),
    );

    // A "pure" regenerate — the merchant asked to try again without
    // stating ANY new creative direction (a bare "Regenerate this.", the
    // Creative Studio UI's own Regenerate button — app/routes/studio.c.$sessionId.tsx)
    // — is weak, but real, negative evidence about the PREVIOUS turn's
    // active field values (see personalization.server.ts's
    // `recordRegenerateSignal` doc comment for why this is deliberately
    // the weakest signal and cannot, on its own, override anything). Only
    // fires when this turn genuinely specified nothing new — a
    // "Regenerate, but darker" turn already has its own new `lighting`
    // value and is handled entirely by the correction signal above.
    const hasNoNewCreativeDirection =
      modeCorrectedIntent.style.length === 0 &&
      modeCorrectedIntent.lighting === null &&
      modeCorrectedIntent.composition === null &&
      modeCorrectedIntent.camera === null &&
      modeCorrectedIntent.colorDirection === null &&
      modeCorrectedIntent.depthOfField === null;
    if (modeCorrectedIntent.intent === "REGENERATE" && hasNoNewCreativeDirection) {
      await recordRegenerateSignal(
        options.userId,
        {
          style: creativeContext.activeStyle,
          lighting: creativeContext.activeLighting,
          composition: creativeContext.activeComposition,
          camera: creativeContext.activeCamera,
          colorDirection: creativeContext.activeColorDirection,
          depthOfField: creativeContext.activeDepthOfField,
        },
        contextForIntent(modeCorrectedIntent.intent),
      );
    }
  }
  const effectiveIntent: ParsedIntent = options.userId
    ? await applyLearnedDefaults(options.userId, modeCorrectedIntent)
    : modeCorrectedIntent;

  // Which learnable fields `applyLearnedDefaults` actually filled in —
  // i.e. which of `effectiveIntent`'s creative fields reflect this
  // user's OWN learned preference rather than something THIS message
  // said. Computed once here (not just for the diagnostic log below) so
  // it can be threaded into the plan builders: `CreativeBrief` needs
  // this distinction to keep "what the user explicitly requested" and
  // "what personalization filled in" structurally separate — see
  // creative-brief.ts's `personalizationApplied` doc comment. Without
  // this, a learned default merged into `effectiveIntent` was
  // indistinguishable from something the merchant actually typed this
  // turn once it reached plan-builder.ts.
  const personalizedFields = (["style", "lighting", "composition", "camera", "colorDirection", "depthOfField"] as const).filter((field) => {
    const before = modeCorrectedIntent[field];
    const after = effectiveIntent[field];
    return (Array.isArray(before) ? before.length === 0 : before === null) && (Array.isArray(after) ? after.length > 0 : after !== null);
  });

  // Cost is mode-aware (an edit/image-to-image request costs more per
  // output than a fresh text-to-image one) — see
  // services/usage/credit-costs.ts's documented rule, not a flat
  // 1-credit-per-output guess. Identical for both session contexts — a
  // standalone generation is not somehow cheaper/free just because there's
  // no Shopify product.
  const requiredCredits = getCreditCost({
    operationType: "IMAGE_GENERATION",
    mode: effectiveIntent.mode,
    outputCount: effectiveIntent.variationCount,
  });
  const entitlement = await checkGenerationEntitlement(context, requiredCredits);
  if (!entitlement.allowed) {
    throw new InsufficientCreditsError(entitlement);
  }

  // The one other genuinely different step: which plan-builder function
  // runs. Both produce the exact same `GenerationPlan` shape — see
  // plan-builder.ts's `buildStandaloneCreativeGenerationPlan` doc comment
  // for why this is "the same generation engine, two entry points," not a
  // second generation system.
  const planBuildStartedAt = Date.now();
  const plan = product
    ? buildCreativeGenerationPlan({
        product,
        intelligence,
        sourceMediaIds: session.sourceMediaId ? [session.sourceMediaId] : [],
        parsedIntent: effectiveIntent,
        previousResultUrl,
        brandStylePreset: null,
        creativeSessionId: session.id,
        rawInstruction: trimmed,
        personalizedFields,
        previousCampaignDNA: creativeContext.activeCampaignDNA,
      })
    : buildStandaloneCreativeGenerationPlan({
        parsedIntent: effectiveIntent,
        uploadedReferenceImageUrls,
        previousResultUrl,
        creativeSessionId: session.id,
        rawInstruction: trimmed,
        // This turn's own `effectiveIntent.subject` wins inside the plan
        // builder; this is only the fallback for a follow-up that
        // doesn't restate the subject — see plan-builder.ts's
        // `activeSubject` doc comment.
        activeSubject: creativeContext.activeSubject,
        activeAction: creativeContext.activeAction,
        personalizedFields,
        previousCampaignDNA: creativeContext.activeCampaignDNA,
      });
  const planBuildMs = Date.now() - planBuildStartedAt;

  // Safe diagnostics: the resolved structural creative decisions for
  // this turn — never the raw message, the synthesized prompt text, or
  // any signed/reference URL (those may describe a real, identifiable
  // person and aren't logged here). Field PRESENCE/mode, not content,
  // is what makes "why didn't this turn's instruction come through
  // correctly" diagnosable after the fact without exposing anything
  // sensitive — see docs/creative-studio.md "Preserve vs. transform".
  // Creative Decision Trace — safe diagnostics for "why was this
  // generated," without exposing raw content: which PROVIDER actually
  // parsed this turn's intent (so a production incident can distinguish
  // "the real LLM path ran" from "it silently fell back to the
  // heuristic parser" — see FallbackIntentParser's own `name` composition),
  // and COUNTS (never the actual text) of what the Creative Director
  // decided was explicit vs. inferred vs. personalized. Every value here
  // is a count, a boolean, or a field name/intent value already safe to
  // log elsewhere in this codebase — never the merchant's message, the
  // synthesized prompt, or any learned preference's actual value.
  const brief = plan.creativeIntent?.creativeBrief;
  logger.info("creative_studio.plan.built", {
    creativeSessionId: session.id,
    isShopifySession: Boolean(product),
    intent: effectiveIntent.intent,
    mode: effectiveIntent.mode,
    hasSubject: Boolean(plan.category && plan.category !== "product"),
    hasAction: Boolean(plan.creativeIntent?.creative.action),
    hasScene: Boolean(plan.creativeDirection.environment),
    hasLighting: Boolean(plan.creativeDirection.lighting),
    referenceImageCount: plan.referenceImages.length,
    outputCount: plan.outputCount,
    // Which provider actually produced this turn's ParsedIntent —
    // e.g. "openai-llm+fallback:heuristic" (FallbackIntentParser's own
    // name composition) makes it observable, after the fact, whether a
    // configured real LLM is genuinely being used in production or the
    // conversational feature is silently running on the heuristic
    // default the whole time.
    intentParserUsed: parser.name,
    // Personalization (Layer 2) — safe: which FIELDS a learned default
    // filled in, never the actual learned values/confidence themselves
    // or anything about who the user is beyond whether one exists.
    personalizationEligible: Boolean(options.userId),
    personalizedFields,
    // Creative Director reasoning (Phase B/E) — counts only.
    explicitTransformationCount: brief?.transformationRequirements.length ?? 0,
    personalizationAppliedCount: brief?.personalizationApplied.length ?? 0,
    inferredCreativeDecisionCount: brief?.inferredCreativeDecisions.length ?? 0,
    preservationRequirementCount: brief?.preservationRequirements.length ?? 0,
    // Phase 1 internal-creative-reasoning fields — a presence flag (never
    // the concept text itself) and a count, same safety rule as every
    // other field logged here.
    hasCreativeConcept: Boolean(brief?.creativeConcept),
    negativeCreativeDecisionCount: brief?.negativeCreativeDecisions.length ?? 0,
    // Campaign Concept Contract observability (quality-floor pass, second
    // round) — enough to diagnose "was this a real semantic-planning
    // concept, or did the deterministic product-derived floor have to
    // step in" purely from Railway logs, without needing raw DB/prompt
    // access (the exact gap that made the prior production incident slow
    // to diagnose). Every value here is a presence flag, count, or an
    // already-safe enum value — never the concept/mechanism text itself.
    referenceExecutionStrategy: brief?.creativeBlueprint?.referenceExecutionStrategy ?? null,
    conceptSource: brief?.creativeBlueprint?.creativeDirection.conceptSource ?? null,
    campaignConceptPresent: Boolean(brief?.creativeConcept),
    visualMechanismPresent: Boolean(brief?.campaignArtDirection.visualMechanism),
    campaignCommunicationMode: brief?.campaignCommunication.mode ?? null,
    qualityProfile: brief?.creativeBlueprint?.qualityIntent.profile ?? null,
    compiledBriefCharacterCount: plan.creativeDirection.prompt.length,
    planningMs: Date.now() - requestStartedAt,
    contextLoadMs,
    productIntelligenceMs,
    intentParseMs,
    planBuildMs,
  });

  const job = await createAndEnqueueGenerationJob(context, {
    productId: product ? product.id : null,
    generationType: "CREATIVE_STUDIO",
    sourceMediaIds: plan.sourceImages.map((image) => image.mediaId),
    planOverride: plan,
    creativeSessionId: session.id,
    beforeEnqueue: async (jobId) => {
      await reserveGenerationCredits(context, jobId, requiredCredits);
    },
  });

  logger.info("creative_studio.job.enqueued", {
    creativeSessionId: session.id,
    generationJobId: job.id,
    requestToEnqueueMs: Date.now() - requestStartedAt,
  });

  await createCreativeMessage({
    shop: context.shop,
    creativeSessionId: session.id,
    role: "USER",
    content: trimmed,
    intent: effectiveIntent as unknown as Record<string, unknown>,
    attachments: uploadedReferenceImageUrls.map((url, index) => ({
      url,
      contentType: options.referenceImages?.[index]?.contentType ?? "image/*",
    })),
    generationJobId: job.id,
  });

  await createCreativeMessage({
    shop: context.shop,
    creativeSessionId: session.id,
    role: "ASSISTANT",
    content: assistantAcknowledgement(effectiveIntent, plan.creativeIntent?.creative.blockedRemovals ?? []),
    generationJobId: job.id,
  });

  if (editSourceResult && resolvedTargetId && resolvedTargetId !== session.currentResultId) {
    // The merchant explicitly referenced a different prior result ("use
    // the second one") — that becomes the new current selection even
    // before this turn's own job resolves.
    await setCurrentResult(context.shop, session.id, resolvedTargetId);
  }

  return { ok: true, generationJobId: job.id, parsedIntent: effectiveIntent };
}

/** `blockedRemovals` surfaces Part 4's "Remove the logo" worked example
 * back to the merchant — a requested removal that named a protected
 * brand/identity element (services/creative-studio/identity-constraints.ts's
 * `filterProtectedRemovals`) is declined, not silently no-op'd, so the
 * merchant sees why the next result still has it. */
function assistantAcknowledgement(intent: ParsedIntent, blockedRemovals: string[]): string {
  const base =
    intent.intent === "ADD_MODEL" || intent.intent === "CHANGE_MODEL"
      ? "Absolutely — I’ll keep the product intact and build the model interaction around it."
      : intent.intent === "CREATE_LIFESTYLE" || intent.intent === "CREATE_MARKETPLACE" || intent.intent === "CREATE_SOCIAL" || intent.intent === "CREATE_BANNER"
        ? "Absolutely — I’ll keep the product as the visual focus and build the campaign around it."
        : intent.mode === "IMAGE_TO_IMAGE" || intent.mode === "IMAGE_EDIT" || intent.mode === "VARIATION"
          ? "Got it — I’ll keep the product intact and refine the requested direction."
          : intent.variationCount > 1
            ? `I’ll create ${intent.variationCount} focused variations around your direction.`
            : "I’ve got it — I’ll shape the image around your direction.";
  if (blockedRemovals.length === 0) return base;
  return `${base} Note: I can't remove ${blockedRemovals.join(", ")} — branding and logos are preserved to keep this an accurate product photo.`;
}

/** "Use this" — the merchant explicitly picks one of the latest job's
 * results to continue editing from. Verifies the result actually
 * belongs to one of this session's own jobs (never trusts a
 * client-supplied result id directly). */
export async function selectCreativeResult(context: AuthContext, sessionId: string, resultId: string): Promise<void> {
  const session = await getCreativeSession(context, sessionId);
  if (!session) throw new CreativeSessionNotFoundError();

  const jobs = await listGenerationJobsForCreativeSession(context.shop, session.id);
  const belongsToSession = jobs.some((job) => job.results.some((result) => result.id === resultId));
  if (!belongsToSession) throw new GenerationResultNotFoundError();

  await setCurrentResult(context.shop, session.id, resultId);
}

/** Reads back the `creative` fields (style/lighting/composition/camera/
 * colorDirection) a specific result's owning job used, plus the
 * preference-context bucket that job's own ORIGINATING intent maps to
 * (`contextForIntent` — see personalization.server.ts's "Context-aware
 * weighting") — the shared lookup both `reviewCreativeResult` and
 * `recordCreativeFeedback` need to turn a reaction to a RESULT into a
 * learning signal about the CREATIVE CHOICES that produced it, recorded
 * into the SAME bucket that request belonged to. `null` for a missing/
 * cross-shop result, a non-CREATIVE_STUDIO job (shouldn't happen for a
 * Creative Studio result, but never assumed), or a plan that fails to
 * parse — personalization is best-effort and must never be the thing
 * that turns a working Approve/Reject click into an error. */
async function getLearnableFieldsForResult(
  context: AuthContext,
  resultId: string,
): Promise<{ fields: LearnableCreativeFields; context: PreferenceContext } | null> {
  const row = await getGenerationPlanForResult(context.shop, resultId);
  if (!row) return null;
  try {
    const creativeIntent = parseGenerationPlan(row.plan).creativeIntent;
    const creative = creativeIntent?.creative;
    if (!creative || !creativeIntent) return null;
    return {
      fields: {
        style: creative.style,
        lighting: creative.lighting,
        composition: creative.composition,
        camera: creative.camera,
        colorDirection: creative.colorDirection,
        depthOfField: creative.depthOfField,
      },
      context: contextForIntent(creativeIntent.intent),
    };
  } catch {
    return null;
  }
}

/** Approve/reject one of this session's results — wraps
 * services/generation/request-generation.server.ts's
 * `reviewGenerationResult` (the SAME review lifecycle every other
 * generationType uses; see docs/creative-studio.md "Review actions" —
 * Creative Studio results are ordinary `GenerationResult` rows, not a
 * parallel review concept), then — only when `userId` is given (a
 * standalone session; see personalization.server.ts's module doc
 * comment) — records the decision as a learning signal for that
 * result's creative choices. The signal recording is best-effort: a
 * failure there is logged and swallowed, never allowed to turn a
 * successful Approve/Reject into a user-visible error. */
export async function reviewCreativeResult(
  context: AuthContext,
  resultId: string,
  decision: Exclude<ReviewStatus, "PENDING">,
  userId?: string | null,
): Promise<void> {
  await reviewGenerationResult(context, resultId, decision);
  if (!userId) return;
  try {
    const learnable = await getLearnableFieldsForResult(context, resultId);
    if (learnable) await recordReviewSignal(userId, learnable.fields, decision, learnable.context);
  } catch (error) {
    logger.warn("creative_studio.review_signal_failed", {
      resultId,
      detail: error instanceof Error ? error.message : "unknown error",
    });
  }
}

/**
 * Records an EXPLICIT reaction to a specific result — the strongest
 * learning signal this module has (see personalization.server.ts's
 * `SIGNAL_WEIGHT`). Distinct from Approve/Reject: this is about the
 * merchant's TASTE ("I like this style"), not whether the result is fit
 * to publish/use — a merchant can reject a result for being the wrong
 * subject entirely while still liking its lighting, or approve one
 * they'd never describe as their preferred aesthetic. No-ops silently
 * (never throws) when there's no real user or no learnable fields to
 * record — see `getLearnableFieldsForResult`.
 */
export async function recordCreativeFeedback(
  context: AuthContext,
  userId: string,
  resultId: string,
  signal: "positive" | "negative",
): Promise<void> {
  const learnable = await getLearnableFieldsForResult(context, resultId);
  if (!learnable) return;
  await recordExplicitFeedback(userId, learnable.fields, signal, learnable.context);
}

export async function listSessionsForProduct(context: AuthContext, productId: string): Promise<CreativeSessionRow[]> {
  await loadOwnedProduct(context, productId);
  return listCreativeSessionsForProduct(context, productId);
}
