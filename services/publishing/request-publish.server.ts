/**
 * Publishing — service entry point used by routes. Mirrors every other
 * domain's shape (services/store-visuals/request-store-visual.server.ts
 * is the closest analog: `requestPublish` is the mutating entry point,
 * `getPublishing`/`listPublishingHistory`/`getLatestPublishStatus` are
 * the read paths). All entry points take an `AuthContext` and re-verify
 * shop ownership — never trust a client-supplied result/product id (see
 * CLAUDE.md "Security requirements").
 *
 * Approval and publishing are explicitly separate concepts (see
 * docs/publishing.md) — this function requires the source result to
 * already be `APPROVED`; nothing anywhere else in this codebase ever
 * calls `requestPublish` automatically from an Approve action.
 */
import type { AuthContext } from "../../lib/auth/types";
import { findProductForShop } from "../../db/repositories/shopify-product.repository";
import {
  createPublishingJob,
  markQueued,
  getPublishingJob,
  getLatestPublishingJobForSource,
  listPublishingHistoryForShop,
  type PublishingJobRow,
  type PublishingJobListFilters,
  type PublishingJobListPage,
} from "../../db/repositories/publishing-job.repository";
import { resolvePublishSource } from "./resolve-source.server";
import { enqueuePublishingJob } from "./queue.server";
import { PublishingSourceTypeSchema } from "./schema";
import type { PublishingSourceTypeValue } from "./types";

export class InvalidPublishRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPublishRequestError";
  }
}

export class PublishSourceNotFoundError extends Error {
  constructor() {
    super("Result not found");
    this.name = "PublishSourceNotFoundError";
  }
}

export class ResultNotApprovedError extends Error {
  constructor() {
    super("Only an approved result can be published.");
    this.name = "ResultNotApprovedError";
  }
}

export class InvalidPublishTargetError extends Error {
  constructor() {
    super("The selected product isn't a valid publish target for this result.");
    this.name = "InvalidPublishTargetError";
  }
}

export class AlreadyPublishedError extends Error {
  constructor() {
    super("This result has already been published.");
    this.name = "AlreadyPublishedError";
  }
}

export class PublishInProgressError extends Error {
  constructor() {
    super("A publish is already in progress for this result.");
    this.name = "PublishInProgressError";
  }
}

export interface RequestPublishInput {
  sourceType: string;
  sourceResultId: string;
  targetProductId: string;
}

/**
 * Creates and enqueues a publish request. Requires explicit merchant
 * intent on every field — never infers a target product, never fires
 * from an Approve action. Prevents accidental double publishing:
 * refuses if the source is already SUCCEEDED (`AlreadyPublishedError`)
 * or has an in-flight job (`PublishInProgressError`) — a merchant who
 * wants to publish again after a FAILED attempt gets a normal new job.
 */
export async function requestPublish(context: AuthContext, input: RequestPublishInput): Promise<{ id: string }> {
  const sourceTypeResult = PublishingSourceTypeSchema.safeParse(input.sourceType);
  if (!sourceTypeResult.success) {
    throw new InvalidPublishRequestError(`Unknown publish source type "${input.sourceType}".`);
  }
  const sourceType: PublishingSourceTypeValue = sourceTypeResult.data;

  if (!input.sourceResultId || !input.targetProductId) {
    throw new InvalidPublishRequestError("A source result and a target product are both required.");
  }

  const source = await resolvePublishSource(context, sourceType, input.sourceResultId);
  if (!source) {
    throw new PublishSourceNotFoundError();
  }
  if (source.reviewStatus !== "APPROVED") {
    throw new ResultNotApprovedError();
  }
  if (!source.candidateProducts.some((p) => p.productId === input.targetProductId)) {
    throw new InvalidPublishTargetError();
  }

  // Re-verify the target product itself belongs to this shop (defense in
  // depth — `candidateProducts` above is already shop-scoped via
  // resolvePublishSource, but every domain in this codebase re-checks a
  // client-supplied id independently rather than trusting one earlier
  // check transitively).
  const targetProduct = await findProductForShop(context, input.targetProductId);
  if (!targetProduct) {
    throw new InvalidPublishTargetError();
  }

  const latest = await getLatestPublishingJobForSource(context.shop, sourceType, input.sourceResultId);
  if (latest) {
    if (latest.status === "SUCCEEDED") {
      throw new AlreadyPublishedError();
    }
    if (latest.status === "PENDING" || latest.status === "QUEUED" || latest.status === "PROCESSING") {
      throw new PublishInProgressError();
    }
  }

  const job = await createPublishingJob({
    shop: context.shop,
    sourceType,
    sourceResultId: input.sourceResultId,
    targetProductId: input.targetProductId,
  });

  await markQueued(context.shop, job.id);
  await enqueuePublishingJob({ shop: context.shop, publishingJobId: job.id });

  return job;
}

export async function getPublishing(context: AuthContext, id: string): Promise<PublishingJobRow | null> {
  return getPublishingJob(context, id);
}

/** The most recent publish state for one result — powers a review
 * card's Ready/Publishing/Published/Failed badge. `null` means never
 * attempted (shows as "Ready to publish"). */
export async function getLatestPublishStatus(
  context: AuthContext,
  sourceType: string,
  sourceResultId: string,
): Promise<PublishingJobRow | null> {
  const parsed = PublishingSourceTypeSchema.safeParse(sourceType);
  if (!parsed.success) return null;
  const row = await getLatestPublishingJobForSource(context.shop, parsed.data, sourceResultId);
  if (!row) return null;
  // getLatestPublishingJobForSource is already shop-scoped by its own
  // query, but route this through the same ownership-checked shape as
  // every other read for consistency/defense in depth.
  return row.shop === context.shop ? row : null;
}

export async function listPublishingHistory(
  context: AuthContext,
  filters: PublishingJobListFilters,
  page: number,
): Promise<PublishingJobListPage> {
  return listPublishingHistoryForShop(context.shop, filters, page);
}
