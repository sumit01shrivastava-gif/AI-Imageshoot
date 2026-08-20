-- CreateEnum
CREATE TYPE "ImageOperation" AS ENUM ('REMOVE_BACKGROUND', 'ENHANCE', 'UPSCALE', 'GENERATE_SHADOW', 'RESIZE', 'CROP');

-- CreateEnum
CREATE TYPE "ProcessingStatus" AS ENUM ('PENDING', 'QUEUED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "ProcessingJob" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sourceMediaId" TEXT NOT NULL,
    "operation" "ImageOperation" NOT NULL,
    "status" "ProcessingStatus" NOT NULL DEFAULT 'PENDING',
    "options" JSONB,
    "identityAnchors" JSONB,
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "providerName" TEXT,
    "providerJobId" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "batchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcessingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingResult" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "processingJobId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "url" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "format" TEXT,
    "providerName" TEXT,
    "providerResultId" TEXT,
    "metadata" JSONB,
    "reviewStatus" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessingResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingBatch" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "operation" "ImageOperation" NOT NULL,
    "sourceSelectionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcessingBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProcessingJob_shop_productId_idx" ON "ProcessingJob"("shop", "productId");

-- CreateIndex
CREATE INDEX "ProcessingJob_shop_status_idx" ON "ProcessingJob"("shop", "status");

-- CreateIndex
CREATE INDEX "ProcessingJob_shop_createdAt_idx" ON "ProcessingJob"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "ProcessingJob_batchId_idx" ON "ProcessingJob"("batchId");

-- CreateIndex
CREATE INDEX "ProcessingResult_shop_processingJobId_idx" ON "ProcessingResult"("shop", "processingJobId");

-- CreateIndex
CREATE INDEX "ProcessingBatch_shop_createdAt_idx" ON "ProcessingBatch"("shop", "createdAt");

-- AddForeignKey
ALTER TABLE "ProcessingJob" ADD CONSTRAINT "ProcessingJob_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ShopifyProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingJob" ADD CONSTRAINT "ProcessingJob_sourceMediaId_fkey" FOREIGN KEY ("sourceMediaId") REFERENCES "ShopifyProductMedia"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingJob" ADD CONSTRAINT "ProcessingJob_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ProcessingBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingResult" ADD CONSTRAINT "ProcessingResult_processingJobId_fkey" FOREIGN KEY ("processingJobId") REFERENCES "ProcessingJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
