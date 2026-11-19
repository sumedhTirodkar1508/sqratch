import prisma from "@/lib/prisma";
import { rateLimit, type RateLimitResult } from "@/lib/rate-limit";

/**
 * Rate limiting that can be enforced across server instances.
 *
 * Selected by configuration: RATE_LIMIT_STORE=postgres uses the
 * `RateLimitCounter` table (one atomic upsert per check); anything else keeps
 * the per-instance in-memory limiter. It is only used for credential sign-in
 * and account-recovery endpoints, where an attacker's volume is low and a
 * database round trip is cheap. Hot public paths (QR scans, analytics) stay in
 * memory on purpose.
 *
 * Availability first: if the store is unreachable or the table is missing, the
 * check falls back to the in-memory limiter. It never blocks a person because
 * the limiter itself is unavailable.
 */
type Db = Pick<typeof prisma, "rateLimitCounter">;

export type RateLimiter = (key: string, limit: number, windowMs: number) => RateLimitResult | Promise<RateLimitResult>;

const isPostgresStore = () => process.env.RATE_LIMIT_STORE === "postgres";
let lastWarnAt = 0;

function warnUnavailable() {
  const now = Date.now();
  if (now - lastWarnAt > 60_000) {
    lastWarnAt = now;
    console.warn("[rate-limit] shared store unavailable; using the per-instance limiter");
  }
}

async function memoryPeek(key: string, limit: number) {
  const { store } = await import("@/lib/rate-limit");
  const entry = store.get(key);
  return { limited: Boolean(entry && entry.resetAt > Date.now() && entry.count >= limit), resetAt: entry?.resetAt ?? 0 };
}

/**
 * Counts this attempt and reports whether it is within `limit` for the window.
 * Three single-row statements, each atomic: make sure the row exists, reset it
 * if its window has ended, then increment and read the new count in one UPDATE.
 */
export async function sharedRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  db: Db = prisma,
): Promise<RateLimitResult> {
  if (!isPostgresStore()) return rateLimit(key, limit, windowMs);
  try {
    const now = new Date();
    const resetAt = new Date(now.getTime() + windowMs);
    await db.rateLimitCounter.createMany({ data: [{ key, count: 0, resetAt }], skipDuplicates: true });
    await db.rateLimitCounter.updateMany({ where: { key, resetAt: { lte: now } }, data: { count: 0, resetAt } });
    const row = await db.rateLimitCounter.update({
      where: { key },
      data: { count: { increment: 1 } },
      select: { count: true, resetAt: true },
    });
    if (Math.random() < 0.01) {
      void db.rateLimitCounter
        .deleteMany({ where: { resetAt: { lt: new Date(now.getTime() - 60 * 60 * 1000) } } })
        .catch(() => undefined);
    }
    return { success: row.count <= limit, remaining: Math.max(0, limit - row.count), resetAt: row.resetAt.getTime() };
  } catch {
    warnUnavailable();
    return rateLimit(key, limit, windowMs);
  }
}

/** Read-only: has `key` already used up `limit` attempts in its current window? */
export async function sharedRateLimited(
  key: string,
  limit: number,
  db: Db = prisma,
): Promise<{ limited: boolean; resetAt: number }> {
  if (!isPostgresStore()) return memoryPeek(key, limit);
  try {
    const row = await db.rateLimitCounter.findFirst({
      where: { key, resetAt: { gt: new Date() } },
      select: { count: true, resetAt: true },
    });
    return { limited: Boolean(row && row.count >= limit), resetAt: row?.resetAt.getTime() ?? 0 };
  } catch {
    warnUnavailable();
    return memoryPeek(key, limit);
  }
}

/** Clears a key (for example after a successful sign-in). Best effort. */
export async function sharedRateLimitReset(key: string, db: Db = prisma): Promise<void> {
  const { store } = await import("@/lib/rate-limit");
  store.delete(key);
  if (!isPostgresStore()) return;
  try {
    await db.rateLimitCounter.deleteMany({ where: { key } });
  } catch {
    warnUnavailable();
  }
}
