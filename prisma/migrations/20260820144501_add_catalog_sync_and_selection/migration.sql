-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('ACTIVE', 'ARCHIVED', 'DRAFT');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('IDLE', 'SYNCING', 'FAILED');

-- CreateTable
CREATE TABLE "ShopifyProduct" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "productType" TEXT NOT NULL DEFAULT '',
    "category" TEXT,
    "vendor" TEXT NOT NULL DEFAULT '',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "ProductStatus" NOT NULL,
    "shopifyCreatedAt" TIMESTAMP(3) NOT NULL,
    "shopifyUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyProductMedia" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "shopifyMediaId" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "originalUrl" TEXT NOT NULL,
    "previewUrl" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "altText" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyProductMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopSyncState" (
    "shop" TEXT NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'IDLE',
    "lastSyncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopSyncState_pkey" PRIMARY KEY ("shop")
);

-- CreateTable
CREATE TABLE "ImageSelection" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImageSelection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImageSelectionItem" (
    "id" TEXT NOT NULL,
    "selectionId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productMediaId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImageSelectionItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShopifyProduct_shop_status_idx" ON "ShopifyProduct"("shop", "status");

-- CreateIndex
CREATE INDEX "ShopifyProduct_shop_updatedAt_idx" ON "ShopifyProduct"("shop", "updatedAt");

-- CreateIndex
CREATE INDEX "ShopifyProduct_shop_title_idx" ON "ShopifyProduct"("shop", "title");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyProduct_shop_shopifyProductId_key" ON "ShopifyProduct"("shop", "shopifyProductId");

-- CreateIndex
CREATE INDEX "ShopifyProductMedia_shop_productId_position_idx" ON "ShopifyProductMedia"("shop", "productId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyProductMedia_shop_shopifyMediaId_key" ON "ShopifyProductMedia"("shop", "shopifyMediaId");

-- CreateIndex
CREATE INDEX "ImageSelection_shop_idx" ON "ImageSelection"("shop");

-- CreateIndex
CREATE INDEX "ImageSelectionItem_shop_idx" ON "ImageSelectionItem"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "ImageSelectionItem_selectionId_productMediaId_key" ON "ImageSelectionItem"("selectionId", "productMediaId");

-- AddForeignKey
ALTER TABLE "ShopifyProductMedia" ADD CONSTRAINT "ShopifyProductMedia_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ShopifyProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageSelectionItem" ADD CONSTRAINT "ImageSelectionItem_selectionId_fkey" FOREIGN KEY ("selectionId") REFERENCES "ImageSelection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageSelectionItem" ADD CONSTRAINT "ImageSelectionItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ShopifyProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageSelectionItem" ADD CONSTRAINT "ImageSelectionItem_productMediaId_fkey" FOREIGN KEY ("productMediaId") REFERENCES "ShopifyProductMedia"("id") ON DELETE CASCADE ON UPDATE CASCADE;
