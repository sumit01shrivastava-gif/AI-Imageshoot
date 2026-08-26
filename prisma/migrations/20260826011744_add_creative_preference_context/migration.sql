-- DropIndex
DROP INDEX "CreativePreferenceObservation_userId_field_value_key";

-- AlterTable
ALTER TABLE "CreativePreferenceObservation" ADD COLUMN     "context" TEXT NOT NULL DEFAULT 'general';

-- CreateIndex
CREATE UNIQUE INDEX "CreativePreferenceObservation_userId_field_value_context_key" ON "CreativePreferenceObservation"("userId", "field", "value", "context");
