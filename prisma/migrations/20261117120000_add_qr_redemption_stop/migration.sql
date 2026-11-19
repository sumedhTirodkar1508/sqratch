-- P12 — stop new QR redemptions.
-- Additive only: three nullable columns and one foreign key; no backfill, no row rewritten.
-- Null means "redeemable", so every existing code and batch behaves exactly as before.
-- Rollback: stop reading and writing the columns (revert the application). The columns may
-- stay. NOTE: codes stopped while the feature was live become redeemable again if the
-- application predicate is removed; resume them deliberately first, or keep the predicate.

-- AlterTable
ALTER TABLE "QRCode" ADD COLUMN "redemptionStoppedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "QRCodeBatch" ADD COLUMN "redemptionStoppedAt" TIMESTAMP(3),
ADD COLUMN "redemptionStoppedById" TEXT;

-- AddForeignKey
ALTER TABLE "QRCodeBatch" ADD CONSTRAINT "QRCodeBatch_redemptionStoppedById_fkey" FOREIGN KEY ("redemptionStoppedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
