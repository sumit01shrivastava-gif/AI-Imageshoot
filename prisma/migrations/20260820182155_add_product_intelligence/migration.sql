-- CreateEnum
CREATE TYPE "IntelligenceStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "ProductIntelligence" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" "IntelligenceStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "category" TEXT,
    "subcategory" TEXT,
    "productType" TEXT,
    "material" TEXT,
    "primaryColor" TEXT,
    "secondaryColors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pattern" TEXT,
    "texture" TEXT,
    "style" TEXT,
    "useCases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "targetAudience" TEXT,
    "genderSuitability" TEXT,
    "seasonality" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pricePositioning" TEXT,
    "visualCharacteristics" JSONB,
    "productDimensions" JSONB,
    "packagingCharacteristics" JSONB,
    "hardwareComponents" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "modelSuitable" BOOLEAN,
    "recommendedModelAttributes" JSONB,
    "recommendedPoseTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "recommendedEnvironments" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "recommendedProps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "recommendedPhotographyStyles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "recommendedAssetTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "identityAnchors" JSONB,
    "imageAnalyses" JSONB,
    "analysisVersion" INTEGER NOT NULL DEFAULT 1,
    "confidence" DOUBLE PRECISION,
    "providerName" TEXT,
    "rawAnalysis" JSONB,
    "sourceShopifyUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductIntelligence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductIntelligence_productId_key" ON "ProductIntelligence"("productId");

-- CreateIndex
CREATE INDEX "ProductIntelligence_shop_status_idx" ON "ProductIntelligence"("shop", "status");

-- AddForeignKey
ALTER TABLE "ProductIntelligence" ADD CONSTRAINT "ProductIntelligence_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ShopifyProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
