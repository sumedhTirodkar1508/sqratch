-- P44 — optional deployment-wide rate-limit counters.
-- Additive only: one table, nothing existing is changed. The application uses it ONLY when
-- RATE_LIMIT_STORE=postgres is set; without that variable (the default) nothing reads or
-- writes it, so this migration may be applied before or after the release. If the table is
-- missing while the variable is set, the limiter falls back to its per-instance memory.
-- Rollback: unset RATE_LIMIT_STORE (or revert the application); the table may stay.

-- CreateTable
CREATE TABLE "RateLimitCounter" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "resetAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitCounter_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "RateLimitCounter_resetAt_idx" ON "RateLimitCounter"("resetAt");
