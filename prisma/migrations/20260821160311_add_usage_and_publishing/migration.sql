-- CreateEnum
CREATE TYPE "UsageOperationType" AS ENUM ('PRODUCT_ANALYSIS', 'IMAGE_GENERATION', 'IMAGE_PROCESSING', 'STORE_VISUAL_GENERATION');

-- CreateEnum
CREATE TYPE "UsageEventStatus" AS ENUM ('SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "PublishingSourceType" AS ENUM ('GENERATION_RESULT', 'PROCESSING_RESULT', 'STORE_VISUAL_RESULT');

-- CreateEnum
CREATE TYPE "PublishingStatus" AS ENUM ('PENDING', 'QUEUED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "operationType" "UsageOperationType" NOT NULL,
    "status" "UsageEventStatus" NOT NULL,
    "jobId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "providerName" TEXT,
    "unitsConsumed" INTEGER NOT NULL DEFAULT 1,
    "outputCount" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishingJob" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "sourceType" "PublishingSourceType" NOT NULL,
    "sourceResultId" TEXT NOT NULL,
    "targetProductId" TEXT NOT NULL,
    "status" "PublishingStatus" NOT NULL DEFAULT 'PENDING',
    "shopifyMediaId" TEXT,
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublishingJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UsageEvent_idempotencyKey_key" ON "UsageEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "UsageEvent_shop_operationType_idx" ON "UsageEvent"("shop", "operationType");

-- CreateIndex
CREATE INDEX "UsageEvent_shop_createdAt_idx" ON "UsageEvent"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "PublishingJob_shop_targetProductId_idx" ON "PublishingJob"("shop", "targetProductId");

-- CreateIndex
CREATE INDEX "PublishingJob_shop_sourceType_sourceResultId_idx" ON "PublishingJob"("shop", "sourceType", "sourceResultId");

-- CreateIndex
CREATE INDEX "PublishingJob_shop_status_idx" ON "PublishingJob"("shop", "status");

-- CreateIndex
CREATE INDEX "PublishingJob_shop_createdAt_idx" ON "PublishingJob"("shop", "createdAt");

-- AddForeignKey
ALTER TABLE "PublishingJob" ADD CONSTRAINT "PublishingJob_targetProductId_fkey" FOREIGN KEY ("targetProductId") REFERENCES "ShopifyProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
