-- CreateEnum
CREATE TYPE "StoreVisualType" AS ENUM ('HOMEPAGE_HERO', 'COLLECTION_BANNER', 'STORE_CTA');

-- CreateEnum
CREATE TYPE "StoreVisualStatus" AS ENUM ('PENDING', 'QUEUED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "StoreVisualJob" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "type" "StoreVisualType" NOT NULL,
    "status" "StoreVisualStatus" NOT NULL DEFAULT 'PENDING',
    "plan" JSONB NOT NULL,
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "providerName" TEXT,
    "providerJobId" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreVisualJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreVisualJobProduct" (
    "id" TEXT NOT NULL,
    "storeVisualJobId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreVisualJobProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreVisualResult" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "storeVisualJobId" TEXT NOT NULL,
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

    CONSTRAINT "StoreVisualResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopSettings" (
    "shop" TEXT NOT NULL,
    "defaultBrandStylePresetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopSettings_pkey" PRIMARY KEY ("shop")
);

-- CreateIndex
CREATE INDEX "StoreVisualJob_shop_type_idx" ON "StoreVisualJob"("shop", "type");

-- CreateIndex
CREATE INDEX "StoreVisualJob_shop_status_idx" ON "StoreVisualJob"("shop", "status");

-- CreateIndex
CREATE INDEX "StoreVisualJob_shop_createdAt_idx" ON "StoreVisualJob"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "StoreVisualJobProduct_shop_idx" ON "StoreVisualJobProduct"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "StoreVisualJobProduct_storeVisualJobId_productId_key" ON "StoreVisualJobProduct"("storeVisualJobId", "productId");

-- CreateIndex
CREATE INDEX "StoreVisualResult_shop_storeVisualJobId_idx" ON "StoreVisualResult"("shop", "storeVisualJobId");

-- AddForeignKey
ALTER TABLE "StoreVisualJobProduct" ADD CONSTRAINT "StoreVisualJobProduct_storeVisualJobId_fkey" FOREIGN KEY ("storeVisualJobId") REFERENCES "StoreVisualJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreVisualJobProduct" ADD CONSTRAINT "StoreVisualJobProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ShopifyProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreVisualResult" ADD CONSTRAINT "StoreVisualResult_storeVisualJobId_fkey" FOREIGN KEY ("storeVisualJobId") REFERENCES "StoreVisualJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
