/**
 * Subscription plan catalog — code constants, not database rows. Same
 * "a small, versioned-in-code catalog, not merchant-editable data" call
 * this codebase already made for the 6 built-in brand style presets
 * (services/generation/brand-style-presets.ts) and Product Intelligence's
 * category recommendations (services/intelligence/category-recommendations.ts).
 * `ShopSubscription.planId` (prisma/schema.prisma) is the only mutable,
 * per-shop state — which `PlanId` a shop currently points at.
 *
 * See docs/billing.md "Plan catalog" for the full policy this table
 * implements, and services/usage/entitlement.server.ts for how these
 * limits are actually enforced.
 */
import type { PlanId, UsageOperationType } from "@prisma/client";

export interface PlanDefinition {
  id: PlanId;
  /** Merchant-facing plan name — shown on /app/billing, never the raw
   * PlanId enum value. */
  name: string;
  /** Merchant-facing one-line description. */
  description: string;
  /** Monthly credit allowance (see services/usage/credit-costs.ts for
   * how a credit cost is computed per operation). */
  monthlyCredits: number;
  /** Monthly price in whole USD — 0 for FREE (never actually submitted
   * to Shopify's Billing API; see subscription.server.ts's `changePlan`,
   * which short-circuits a downgrade-to-FREE into a plain cancellation
   * instead of an appSubscriptionCreate($0) call). */
  priceUsd: number;
  /** The largest single generation output dimension this plan allows,
   * in pixels on the long edge. Enforced by a future provider-input
   * clamp (services/generation/build-input.ts) — see docs/billing.md
   * "Known limitations" for what's wired vs. what's a stated limit. */
  maxGenerationResolutionPx: number;
  /** Maximum outputCount a single generation request may ask for. */
  maxOutputsPerGeneration: number;
  /** Which UsageOperationType values this plan may use at all — an
   * operation absent from this list is blocked outright regardless of
   * remaining credits (services/usage/entitlement.server.ts's
   * `canUseOperation`). */
  allowedOperations: readonly UsageOperationType[];
  creativeStudioEnabled: boolean;
  productIntelligenceEnabled: boolean;
  storeVisualsEnabled: boolean;
  /** Maximum ProcessingJob batch size (images per batch) this plan
   * allows — mirrors maxOutputsPerGeneration's role for the processing
   * domain. */
  maxProcessingBatchSize: number;
  publishingEnabled: boolean;
  /** How many days a generated asset's storage/signed-URL history is
   * guaranteed to remain available. Documented policy — no retention
   * -deletion job exists yet (see docs/billing.md "Known limitations");
   * nothing currently deletes an asset early to enforce this number. */
  assetRetentionDays: number;
  /** How many distinct shops/staff can be attached to this plan's
   * billing — this app has no multi-staff/team concept yet (one
   * Shopify shop = one tenant throughout), so this is always 1 today
   * and exists only so the shape doesn't need to change when that
   * changes. */
  teamSeats: number;
}

const ALL_OPERATIONS: readonly UsageOperationType[] = [
  "PRODUCT_ANALYSIS",
  "IMAGE_GENERATION",
  "IMAGE_PROCESSING",
  "STORE_VISUAL_GENERATION",
];

export const PLANS: Record<PlanId, PlanDefinition> = {
  FREE: {
    id: "FREE",
    name: "Free",
    description: "Try AI product photography with a small monthly allowance.",
    monthlyCredits: 40,
    priceUsd: 0,
    maxGenerationResolutionPx: 1024,
    maxOutputsPerGeneration: 1,
    allowedOperations: ["PRODUCT_ANALYSIS", "IMAGE_GENERATION", "IMAGE_PROCESSING"],
    creativeStudioEnabled: true,
    productIntelligenceEnabled: true,
    storeVisualsEnabled: false,
    maxProcessingBatchSize: 5,
    publishingEnabled: false,
    assetRetentionDays: 30,
    teamSeats: 1,
  },
  STARTER: {
    id: "STARTER",
    name: "Starter",
    description: "For growing stores producing product imagery regularly.",
    monthlyCredits: 200,
    priceUsd: 19,
    maxGenerationResolutionPx: 1536,
    maxOutputsPerGeneration: 3,
    allowedOperations: ALL_OPERATIONS,
    creativeStudioEnabled: true,
    productIntelligenceEnabled: true,
    storeVisualsEnabled: true,
    maxProcessingBatchSize: 25,
    publishingEnabled: true,
    assetRetentionDays: 90,
    teamSeats: 1,
  },
  PRO: {
    id: "PRO",
    name: "Pro",
    description: "Higher-volume generation with larger batches and higher resolution.",
    monthlyCredits: 800,
    priceUsd: 49,
    maxGenerationResolutionPx: 2048,
    maxOutputsPerGeneration: 6,
    allowedOperations: ALL_OPERATIONS,
    creativeStudioEnabled: true,
    productIntelligenceEnabled: true,
    storeVisualsEnabled: true,
    maxProcessingBatchSize: 100,
    publishingEnabled: true,
    assetRetentionDays: 180,
    teamSeats: 3,
  },
  BUSINESS: {
    id: "BUSINESS",
    name: "Business",
    description: "Maximum volume and resolution for high-throughput catalogs.",
    monthlyCredits: 2500,
    priceUsd: 149,
    maxGenerationResolutionPx: 2048,
    maxOutputsPerGeneration: 10,
    allowedOperations: ALL_OPERATIONS,
    creativeStudioEnabled: true,
    productIntelligenceEnabled: true,
    storeVisualsEnabled: true,
    maxProcessingBatchSize: 500,
    publishingEnabled: true,
    assetRetentionDays: 365,
    teamSeats: 10,
  },
};

export const DEFAULT_PLAN_ID: PlanId = "FREE";

export function getPlanDefinition(planId: PlanId): PlanDefinition {
  return PLANS[planId];
}

/** Ordered cheapest-to-most-expensive — drives the Upgrade/Downgrade
 * button set on /app/billing (a plan strictly above the current one is
 * "Upgrade", strictly below is "Downgrade"). */
export const PLAN_ORDER: readonly PlanId[] = ["FREE", "STARTER", "PRO", "BUSINESS"];
