import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realDbTest } from "./helpers/real-db";

const { skipReason } = realDbTest("RATE_LIMIT_REAL_DB");

test("the shared limiter counts across instances, resets with its window and never over-admits", { skip: skipReason }, async () => {
  process.env.RATE_LIMIT_STORE = "postgres";
  const { default: prisma } = await import("../src/lib/prisma");
  const { sharedRateLimit, sharedRateLimited } = await import("../src/lib/rate-limit-shared");
  const { store } = await import("../src/lib/rate-limit");
  const key = `test:${randomUUID()}`;
  try {
    // Two "instances": the per-instance memory is cleared between calls, the shared count is not.
    assert.equal((await sharedRateLimit(key, 3, 60_000)).success, true);
    store.clear();
    assert.equal((await sharedRateLimit(key, 3, 60_000)).success, true);
    store.clear();
    assert.equal((await sharedRateLimit(key, 3, 60_000)).success, true);
    store.clear();
    const fourth = await sharedRateLimit(key, 3, 60_000);
    assert.equal(fourth.success, false);
    assert.equal(fourth.remaining, 0);
    assert.equal((await sharedRateLimited(key, 3)).limited, true);
    assert.equal((await sharedRateLimited(`${key}-other`, 3)).limited, false);

    // Concurrent attempts: exactly `limit` get through.
    const burst = `test:${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 25 }, () => sharedRateLimit(burst, 5, 60_000)));
    assert.equal(results.filter((r) => r.success).length, 5);

    // An expired window starts again.
    const expiring = `test:${randomUUID()}`;
    await sharedRateLimit(expiring, 1, 60_000);
    assert.equal((await sharedRateLimit(expiring, 1, 60_000)).success, false);
    await prisma.rateLimitCounter.update({ where: { key: expiring }, data: { resetAt: new Date(Date.now() - 1000) } });
    assert.equal((await sharedRateLimited(expiring, 1)).limited, false);
    assert.equal((await sharedRateLimit(expiring, 1, 60_000)).success, true);

    // A store failure never blocks anyone: it falls back to per-instance memory.
    const broken = { rateLimitCounter: { createMany: async () => { throw new Error("relation does not exist"); }, findFirst: async () => { throw new Error("relation does not exist"); } } } as never;
    const fallback = await sharedRateLimit(`test:${randomUUID()}`, 1, 60_000, broken);
    assert.equal(fallback.success, true);
    assert.equal((await sharedRateLimited(`test:${randomUUID()}`, 1, broken)).limited, false);
  } finally {
    await prisma.rateLimitCounter.deleteMany({ where: { key: { startsWith: "test:" } } });
    delete process.env.RATE_LIMIT_STORE;
  }
});
