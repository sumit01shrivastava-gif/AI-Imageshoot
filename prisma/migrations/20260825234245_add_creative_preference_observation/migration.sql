-- CreateTable
CREATE TABLE "CreativePreferenceObservation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "positiveWeight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "negativeWeight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sampleCount" INTEGER NOT NULL DEFAULT 0,
    "lastObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreativePreferenceObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreativePreferenceObservation_userId_idx" ON "CreativePreferenceObservation"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CreativePreferenceObservation_userId_field_value_key" ON "CreativePreferenceObservation"("userId", "field", "value");

-- AddForeignKey
ALTER TABLE "CreativePreferenceObservation" ADD CONSTRAINT "CreativePreferenceObservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
