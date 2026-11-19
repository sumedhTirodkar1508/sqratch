-- P13 — staged lesson-video assets.
-- Additive only: one enum and one table; nothing existing is changed and nothing is backfilled.
-- Objects uploaded before this release have no row; saving or removing a lesson video inserts one
-- on demand (and only when no other lesson references the object). They are never swept.
-- Rollback: stop reading and writing the table (revert the application). The table may stay.
-- Do not schedule the sweeper until the owner has reviewed docs/lesson-video-uploads.md.

-- CreateEnum
CREATE TYPE "StagedAssetStatus" AS ENUM ('STAGED', 'ATTACHED', 'CLEANUP_CLAIMED', 'DELETED');

-- CreateTable
CREATE TABLE "StagedAsset" (
    "id" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'LESSON_VIDEO',
    "ownerUserId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "lessonId" TEXT,
    "status" "StagedAssetStatus" NOT NULL DEFAULT 'STAGED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attachedAt" TIMESTAMP(3),
    "cleanupClaimedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "StagedAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StagedAsset_bucket_path_key" ON "StagedAsset"("bucket", "path");

-- CreateIndex
CREATE INDEX "StagedAsset_status_createdAt_idx" ON "StagedAsset"("status", "createdAt");

-- CreateIndex
CREATE INDEX "StagedAsset_lessonId_idx" ON "StagedAsset"("lessonId");
