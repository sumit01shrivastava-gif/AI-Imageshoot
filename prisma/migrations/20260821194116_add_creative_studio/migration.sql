-- CreateEnum
CREATE TYPE "CreativeSessionStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CreativeSourceType" AS ENUM ('PRODUCT_IMAGE', 'GENERATION_RESULT', 'PROCESSING_RESULT', 'STORE_VISUAL_RESULT');

-- CreateEnum
CREATE TYPE "CreativeMessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "CreditReservationStatus" AS ENUM ('RESERVED', 'SETTLED', 'REFUNDED');

-- AlterEnum
ALTER TYPE "GenerationType" ADD VALUE 'CREATIVE_STUDIO';

-- AlterTable
ALTER TABLE "GenerationJob" ADD COLUMN     "creativeSessionId" TEXT;

-- CreateTable
CREATE TABLE "CreativeSession" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sourceType" "CreativeSourceType" NOT NULL DEFAULT 'PRODUCT_IMAGE',
    "sourceResultId" TEXT,
    "sourceMediaId" TEXT,
    "currentResultId" TEXT,
    "status" "CreativeSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreativeSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeMessage" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "creativeSessionId" TEXT NOT NULL,
    "role" "CreativeMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "intent" JSONB,
    "generationJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreativeMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditReservation" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL DEFAULT 1,
    "status" "CreditReservationStatus" NOT NULL DEFAULT 'RESERVED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "CreditReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreativeSession_shop_productId_idx" ON "CreativeSession"("shop", "productId");

-- CreateIndex
CREATE INDEX "CreativeSession_shop_status_idx" ON "CreativeSession"("shop", "status");

-- CreateIndex
CREATE INDEX "CreativeSession_shop_createdAt_idx" ON "CreativeSession"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "CreativeMessage_shop_creativeSessionId_createdAt_idx" ON "CreativeMessage"("shop", "creativeSessionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreditReservation_jobId_key" ON "CreditReservation"("jobId");

-- CreateIndex
CREATE INDEX "CreditReservation_shop_status_idx" ON "CreditReservation"("shop", "status");

-- CreateIndex
CREATE INDEX "CreditReservation_shop_createdAt_idx" ON "CreditReservation"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "GenerationJob_creativeSessionId_idx" ON "GenerationJob"("creativeSessionId");

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_creativeSessionId_fkey" FOREIGN KEY ("creativeSessionId") REFERENCES "CreativeSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeSession" ADD CONSTRAINT "CreativeSession_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ShopifyProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeSession" ADD CONSTRAINT "CreativeSession_sourceMediaId_fkey" FOREIGN KEY ("sourceMediaId") REFERENCES "ShopifyProductMedia"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeMessage" ADD CONSTRAINT "CreativeMessage_creativeSessionId_fkey" FOREIGN KEY ("creativeSessionId") REFERENCES "CreativeSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
