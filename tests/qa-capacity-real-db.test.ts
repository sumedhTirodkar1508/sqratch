import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realDbTest } from "./helpers/real-db";
import { utcDayRange } from "../src/lib/qa-capacity";
import { isUniqueViolationOn } from "../src/lib/prisma-errors";

const { skipReason } = realDbTest("QA_CAPACITY_REAL_DB");

test("utcDayRange is the UTC calendar day regardless of the server timezone", () => {
  const { dayStart, dayEnd } = utcDayRange(new Date("2026-03-09T23:59:59.999Z"));
  assert.equal(dayStart.toISOString(), "2026-03-09T00:00:00.000Z");
  assert.equal(dayEnd.toISOString(), "2026-03-10T00:00:00.000Z");
  assert.equal(utcDayRange(new Date("2026-03-10T00:00:00.000Z")).dayStart.toISOString(), "2026-03-10T00:00:00.000Z");
});

test("concurrent question submissions never exceed the daily limit", { skip: skipReason }, async () => {
  const { default: prisma } = await import("../src/lib/prisma");
  const { submitQuestionWithinLimit } = await import("../src/lib/qa-capacity");
  const key = randomUUID();
  const creator = await prisma.user.create({ data: { email: `${key}-c@example.test`, role: "CREATOR" } });
  const profile = await prisma.creatorProfile.create({ data: { userId: creator.id } });
  const experience = await prisma.experience.create({ data: { title: `QA ${key}`, slug: `qa-${key}`, creatorId: profile.id } });
  const asker = await prisma.user.create({ data: { email: `${key}-a@example.test` } });
  const other = await prisma.user.create({ data: { email: `${key}-o@example.test` } });
  try {
    const submit = (userId: string, limit: number, n: number) =>
      Promise.all(
        Array.from({ length: n }, (_, i) =>
          submitQuestionWithinLimit(prisma, { experienceId: experience.id, userId, body: `q${i}`, dailyLimit: limit }),
        ),
      );

    // Limit 1, ten racers: exactly one question is created.
    const first = await submit(asker.id, 1, 10);
    assert.equal(first.filter((r) => r.ok).length, 1, "exactly one winner");
    assert.ok(first.every((r) => r.ok || r.reason === "LIMIT_REACHED" || r.reason === "BUSY"));
    assert.equal(await prisma.question.count({ where: { askedById: asker.id } }), 1);

    // Limit 3, ten racers for another user: never more than three exist.
    const second = await submit(other.id, 3, 10);
    const created = await prisma.question.count({ where: { askedById: other.id } });
    assert.equal(second.filter((r) => r.ok).length, created);
    assert.ok(created <= 3 && created >= 1, `created ${created}`);
    // Once the dust settles a sequential call fills the remainder and then refuses.
    for (let i = created; i < 3; i += 1) {
      const r = await submit(other.id, 3, 1);
      assert.equal(r[0].ok, true);
    }
    const refused = await submit(other.id, 3, 1);
    assert.deepEqual(refused[0], { ok: false, reason: "LIMIT_REACHED" });
    assert.equal(await prisma.question.count({ where: { askedById: other.id } }), 3);

    // Questions from yesterday (UTC) do not count towards today.
    const now = new Date("2026-05-02T12:00:00.000Z");
    const yesterday = new Date("2026-05-01T23:59:59.000Z");
    const dayUser = await prisma.user.create({ data: { email: `${key}-d@example.test` } });
    await prisma.question.create({ data: { experienceId: experience.id, askedById: dayUser.id, body: "old", createdAt: yesterday } });
    const todayResult = await submitQuestionWithinLimit(prisma, { experienceId: experience.id, userId: dayUser.id, body: "new", dailyLimit: 1, now });
    assert.equal(todayResult.ok, true);
    assert.equal((todayResult as { remainingToday: number }).remainingToday, 0);
    await prisma.user.delete({ where: { id: dayUser.id } }).catch(() => undefined);
  } finally {
    await prisma.question.deleteMany({ where: { experienceId: experience.id } });
    await prisma.experience.delete({ where: { id: experience.id } });
    await prisma.creatorProfile.delete({ where: { id: profile.id } });
    await prisma.user.deleteMany({ where: { email: { startsWith: key } } });
  }
});

test("a reward code collision is classified as retryable and no other unique violation is", { skip: skipReason }, async () => {
  const { default: prisma } = await import("../src/lib/prisma");
  const key = randomUUID();
  const user = await prisma.user.create({ data: { email: `${key}-u@example.test` } });
  const brand = await prisma.brand.create({ data: { name: `Brand ${key}`, slug: `brand-${key}` } });
  const offer = await prisma.brandRewardOffer.create({
    data: { brandId: brand.id, provider: "SHOPIFY", title: "Fixture", pointsCost: 10, discountAmountCents: 100 },
  });
  const row = (idempotencyKey: string, code: string) => ({
    userId: user.id, brandId: brand.id, offerId: offer.id, provider: "SHOPIFY" as const, idempotencyKey, code,
    status: "PENDING" as never, pointsCost: 10, externalAccountId: "fixture.example", discountType: "FIXED_AMOUNT" as const, discountAmountCents: 100,
  });
  const capture = async (data: ReturnType<typeof row>) => {
    try {
      await prisma.commerceRewardRedemption.create({ data });
      return null;
    } catch (error) {
      return error;
    }
  };
  try {
    assert.equal(await capture(row(`${key}-1`, `CODE-${key}`)), null);

    const codeCollision = await capture(row(`${key}-2`, `CODE-${key}`));
    assert.ok(codeCollision, "duplicate code must fail");
    assert.equal(isUniqueViolationOn(codeCollision, "code"), true, "code collision is retryable");
    assert.equal(isUniqueViolationOn(codeCollision, "idempotencyKey"), false);

    const keyCollision = await capture(row(`${key}-1`, `OTHER-${key}`));
    assert.ok(keyCollision, "duplicate idempotency key must fail");
    assert.equal(isUniqueViolationOn(keyCollision, "idempotencyKey"), true);
    assert.equal(isUniqueViolationOn(keyCollision, "code"), false, "an idempotency-key conflict is never retried as a code collision");

    // A different database error is not a unique violation at all.
    const missingOffer = await capture({ ...row(`${key}-3`, `THIRD-${key}`), offerId: "does-not-exist" });
    assert.ok(missingOffer);
    assert.equal(isUniqueViolationOn(missingOffer, "code"), false);
  } finally {
    await prisma.commerceRewardRedemption.deleteMany({ where: { brandId: brand.id } });
    await prisma.brandRewardOffer.delete({ where: { id: offer.id } });
    await prisma.brand.delete({ where: { id: brand.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test("the redeem route decides code-collision retries through isUniqueViolationOn", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("src/app/api/rewards/shopify/redeem/route.ts", "utf8");
  assert.match(source, /isUniqueViolationOn\(error, "code"\)/);
  assert.match(source, /!isUniqueViolationOn\(error, "idempotencyKey"\)/);
  assert.doesNotMatch(source, /meta\?\.target/);
});
