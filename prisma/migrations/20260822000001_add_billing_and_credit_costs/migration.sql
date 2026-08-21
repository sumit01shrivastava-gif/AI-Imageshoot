-- CreateEnum
CREATE TYPE "PlanId" AS ENUM ('FREE', 'STARTER', 'PRO', 'BUSINESS');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('PENDING', 'ACTIVE', 'CANCELLED', 'DECLINED', 'EXPIRED', 'FROZEN');

-- CreateEnum
CREATE TYPE "BillingEventType" AS ENUM ('SUBSCRIPTION_REQUESTED', 'SUBSCRIPTION_ACTIVATED', 'SUBSCRIPTION_CANCELLED', 'SUBSCRIPTION_DECLINED', 'SUBSCRIPTION_EXPIRED', 'PLAN_CHANGED', 'WEBHOOK_RECEIVED');

-- AlterEnum
BEGIN;
CREATE TYPE "CreditReservationStatus_new" AS ENUM ('RESERVED', 'CONSUMED', 'REFUNDED');
ALTER TABLE "public"."CreditReservation" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "CreditReservation" ALTER COLUMN "status" TYPE "CreditReservationStatus_new" USING ("status"::text::"CreditReservationStatus_new");
ALTER TYPE "CreditReservationStatus" RENAME TO "CreditReservationStatus_old";
ALTER TYPE "CreditReservationStatus_new" RENAME TO "CreditReservationStatus";
DROP TYPE "public"."CreditReservationStatus_old";
ALTER TABLE "CreditReservation" ALTER COLUMN "status" SET DEFAULT 'RESERVED';
COMMIT;

-- AlterTable
ALTER TABLE "CreditReservation" ADD COLUMN     "operationType" "UsageOperationType" NOT NULL;

-- CreateTable
CREATE TABLE "ShopSubscription" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "planId" "PlanId" NOT NULL DEFAULT 'FREE',
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "shopifySubscriptionId" TEXT,
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingEvent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "type" "BillingEventType" NOT NULL,
    "shopifySubscriptionId" TEXT,
    "fromPlanId" "PlanId",
    "toPlanId" "PlanId",
    "idempotencyKey" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopSubscription_shop_key" ON "ShopSubscription"("shop");

-- CreateIndex
CREATE INDEX "ShopSubscription_status_idx" ON "ShopSubscription"("status");

-- CreateIndex
CREATE INDEX "ShopSubscription_shopifySubscriptionId_idx" ON "ShopSubscription"("shopifySubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingEvent_idempotencyKey_key" ON "BillingEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "BillingEvent_shop_createdAt_idx" ON "BillingEvent"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "BillingEvent_shop_type_idx" ON "BillingEvent"("shop", "type");

-- CreateIndex
CREATE INDEX "CreditReservation_shop_operationType_idx" ON "CreditReservation"("shop", "operationType");

