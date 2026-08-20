/**
 * Repository for `ProductIntelligence` — one row per product, the current
 * structured Product Intelligence profile (see prisma/schema.prisma's
 * model comment and docs/product-intelligence.md).
 *
 * `rawAnalysis` (the unvalidated provider output, kept for debugging) is
 * deliberately excluded from every select in this file except the
 * internal worker-only helpers that explicitly need it — nothing
 * merchant-facing should ever see raw provider output (see CLAUDE.md
 * "Safe error handling").
 */
import type { Prisma } from "@prisma/client";
import prisma from "../client.server";
import type { AuthContext } from "../../lib/auth/types";
import { assertShopOwnership } from "../../lib/auth/tenant.server";
import type { ProductIntelligenceData } from "../../services/intelligence/schema";

/** Fields safe to return to a route/UI — excludes `rawAnalysis`. */
const SAFE_SELECT = {
  id: true,
  shop: true,
  productId: true,
  status: true,
  errorMessage: true,

  category: true,
  subcategory: true,
  productType: true,

  material: true,
  primaryColor: true,
  secondaryColors: true,

  pattern: true,
  texture: true,
  style: true,

  useCases: true,
  targetAudience: true,
  genderSuitability: true,
  seasonality: true,
  pricePositioning: true,

  visualCharacteristics: true,
  productDimensions: true,
  packagingCharacteristics: true,
  hardwareComponents: true,

  modelSuitable: true,
  recommendedModelAttributes: true,
  recommendedPoseTypes: true,

  recommendedEnvironments: true,
  recommendedProps: true,
  recommendedPhotographyStyles: true,
  recommendedAssetTypes: true,

  identityAnchors: true,
  imageAnalyses: true,

  analysisVersion: true,
  confidence: true,
  providerName: true,
  sourceShopifyUpdatedAt: true,

  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProductIntelligenceSelect;

export type ProductIntelligenceRow = Prisma.ProductIntelligenceGetPayload<{ select: typeof SAFE_SELECT }>;

/** Loads the current profile for one product, verifying shop ownership.
 * Returns `null` if no profile exists yet (never analyzed). */
export async function getForProduct(
  context: AuthContext,
  productId: string,
): Promise<ProductIntelligenceRow | null> {
  const row = await prisma.productIntelligence.findUnique({
    where: { productId },
    select: SAFE_SELECT,
  });
  if (!row) return null;
  assertShopOwnership(context, row.shop);
  return row;
}

/**
 * Ensures a row exists for this product, defaulting to `PENDING`.
 * Idempotent and non-destructive: if a row already exists (in any status,
 * including a prior READY profile), this leaves it untouched — the worker
 * (`markProcessing`/`saveResult`/`markFailed`) owns all state transitions,
 * not the enqueue path. See services/intelligence/product-intelligence.server.ts.
 */
export async function ensurePendingAnalysis(shop: string, productId: string): Promise<void> {
  await prisma.productIntelligence.upsert({
    where: { productId },
    create: { shop, productId, status: "PENDING" },
    update: {},
  });
}

export async function markProcessing(shop: string, productId: string): Promise<void> {
  await prisma.productIntelligence.upsert({
    where: { productId },
    create: { shop, productId, status: "PROCESSING" },
    update: { status: "PROCESSING", errorMessage: null },
  });
}

/** `message` must already be merchant-safe (no stack traces/internal
 * detail) — see CLAUDE.md "Safe error handling". */
export async function markFailed(shop: string, productId: string, message: string): Promise<void> {
  await prisma.productIntelligence.upsert({
    where: { productId },
    create: { shop, productId, status: "FAILED", errorMessage: message },
    update: { status: "FAILED", errorMessage: message },
  });
}

export interface SaveResultMeta {
  providerName: string;
  /** The product's `shopifyUpdatedAt` at the moment analysis ran — the
   * staleness watermark, see services/intelligence/stale.ts. */
  sourceShopifyUpdatedAt: Date;
  /** Raw, unvalidated provider output — stored for debugging only, never
   * selected back out via `SAFE_SELECT`. */
  rawAnalysis: unknown;
}

/**
 * Persists a validated analysis result as the product's new current
 * profile, bumping `analysisVersion`.
 *
 * Version semantics: `analysisVersion` defaults to 0 in the schema and is
 * ONLY ever written here — `ensurePendingAnalysis`/`markProcessing` (both
 * of which run, and may upsert this row, before this function does in the
 * real PENDING → PROCESSING → READY lifecycle) never touch it. So reading
 * the row's current `analysisVersion` and adding 1 is safe regardless of
 * how many bookkeeping upserts already touched the row on the way here —
 * unlike `status`, which `markProcessing` deliberately overwrites away
 * from `READY` before this runs, so checking `status === "READY"` here
 * would (and did) give the wrong answer on re-analysis.
 */
export async function saveResult(
  shop: string,
  productId: string,
  data: ProductIntelligenceData,
  meta: SaveResultMeta,
): Promise<void> {
  const existing = await prisma.productIntelligence.findUnique({
    where: { productId },
    select: { analysisVersion: true },
  });
  const nextVersion = (existing?.analysisVersion ?? 0) + 1;

  await prisma.productIntelligence.upsert({
    where: { productId },
    create: {
      shop,
      productId,
      status: "READY",
      errorMessage: null,
      ...toColumns(data),
      analysisVersion: nextVersion,
      providerName: meta.providerName,
      sourceShopifyUpdatedAt: meta.sourceShopifyUpdatedAt,
      rawAnalysis: meta.rawAnalysis as Prisma.InputJsonValue,
    },
    update: {
      status: "READY",
      errorMessage: null,
      ...toColumns(data),
      analysisVersion: nextVersion,
      providerName: meta.providerName,
      sourceShopifyUpdatedAt: meta.sourceShopifyUpdatedAt,
      rawAnalysis: meta.rawAnalysis as Prisma.InputJsonValue,
    },
  });
}

function toColumns(data: ProductIntelligenceData) {
  return {
    category: data.category,
    subcategory: data.subcategory,
    productType: data.productType,

    material: data.material,
    primaryColor: data.primaryColor,
    secondaryColors: data.secondaryColors,

    pattern: data.pattern,
    texture: data.texture,
    style: data.style,

    useCases: data.useCases,
    targetAudience: data.targetAudience,
    genderSuitability: data.genderSuitability,
    seasonality: data.seasonality,
    pricePositioning: data.pricePositioning,

    visualCharacteristics: (data.visualCharacteristics ?? undefined) as Prisma.InputJsonValue | undefined,
    productDimensions: (data.productDimensions ?? undefined) as Prisma.InputJsonValue | undefined,
    packagingCharacteristics: (data.packagingCharacteristics ?? undefined) as Prisma.InputJsonValue | undefined,
    hardwareComponents: data.hardwareComponents,

    modelSuitable: data.modelSuitable,
    recommendedModelAttributes: (data.recommendedModelAttributes ?? undefined) as
      | Prisma.InputJsonValue
      | undefined,
    recommendedPoseTypes: data.recommendedPoseTypes,

    recommendedEnvironments: data.recommendedEnvironments,
    recommendedProps: data.recommendedProps,
    recommendedPhotographyStyles: data.recommendedPhotographyStyles,
    recommendedAssetTypes: data.recommendedAssetTypes,

    identityAnchors: data.identityAnchors as unknown as Prisma.InputJsonValue,
    imageAnalyses: data.imageAnalyses as unknown as Prisma.InputJsonValue,

    confidence: data.confidence,
  };
}

