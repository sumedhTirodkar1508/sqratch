-- P37 — immutable lesson completion time.
-- Additive only: one nullable column. No backfill: completions recorded before this release keep
-- NULL and are reported as "completion date not recorded". No timestamp is invented for them.
-- Rollback: stop reading and writing the column (revert the application); it may stay.

-- AlterTable
ALTER TABLE "LessonProgress" ADD COLUMN "completedAt" TIMESTAMP(3);
