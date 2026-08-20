-- CreateEnum
CREATE TYPE "GenerationType" AS ENUM ('PRODUCT_CLEANUP', 'BACKGROUND_REMOVAL', 'BACKGROUND_REPLACEMENT', 'LIFESTYLE', 'MODEL_SHOOT', 'BANNER', 'CATEGORY_BANNER', 'CTA', 'CAMPAIGN');

-- CreateEnum
CREATE TYPE "GenerationStatus" AS ENUM ('PENDING', 'QUEUED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "GenerationJob" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "type" "GenerationType" NOT NULL,
    "status" "GenerationStatus" NOT NULL DEFAULT 'PENDING',
    "sourceMediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "plan" JSONB NOT NULL,
    "identityAnchors" JSONB,
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "providerName" TEXT,
    "providerJobId" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GenerationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenerationResult" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "generationJobId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "url" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "format" TEXT,
    "providerName" TEXT,
    "providerResultId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GenerationResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GenerationJob_shop_productId_idx" ON "GenerationJob"("shop", "productId");

-- CreateIndex
CREATE INDEX "GenerationJob_shop_status_idx" ON "GenerationJob"("shop", "status");

-- CreateIndex
CREATE INDEX "GenerationJob_shop_createdAt_idx" ON "GenerationJob"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "GenerationResult_shop_generationJobId_idx" ON "GenerationResult"("shop", "generationJobId");

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ShopifyProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationResult" ADD CONSTRAINT "GenerationResult_generationJobId_fkey" FOREIGN KEY ("generationJobId") REFERENCES "GenerationJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
