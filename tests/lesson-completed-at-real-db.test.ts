import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { realDbTest } from "./helpers/real-db";

const { skipReason } = realDbTest("COMPLETED_AT_REAL_DB");
const sid = () => randomBytes(24).toString("hex");

async function world() {
  const { default: prisma } = await import("../src/lib/prisma");
  const key = randomUUID();
  const owner = await prisma.user.create({ data: { email: `${key}-o@example.test`, role: "CREATOR" } });
  const profile = await prisma.creatorProfile.create({ data: { userId: owner.id } });
  const experience = await prisma.experience.create({ data: { creatorId: profile.id, title: key, slug: `e-${key}` } });
  const course = await prisma.course.create({ data: { experienceId: experience.id, title: key } });
  const lessons = await Promise.all([1, 2, 3, 4].map((n) => prisma.lesson.create({ data: { courseId: course.id, title: `L${n}`, videoSource: "YOUTUBE", youtubeUrl: "https://youtu.be/x" } })));
  const learners = await Promise.all([1, 2, 3].map((n) => prisma.user.create({ data: { email: `${key}-l${n}@example.test` } })));
  return { prisma, key, owner, profile, experience, course, lessons, learners, sessions: [] as string[] };
}
type World = Awaited<ReturnType<typeof world>>;
async function cleanup(w: World) {
  const { prisma } = w;
  await prisma.lessonProgress.deleteMany({ where: { lesson: { courseId: w.course.id } } });
  await prisma.userSession.deleteMany({ where: { id: { in: w.sessions } } });
  await prisma.experience.deleteMany({ where: { id: w.experience.id } });
  await prisma.creatorProfile.deleteMany({ where: { id: w.profile.id } });
  await prisma.user.deleteMany({ where: { id: { in: [w.owner.id, ...w.learners.map((l) => l.id)] } } });
}
const row = (w: World, userId: string, lessonId: string) => w.prisma.lessonProgress.findUniqueOrThrow({ where: { userId_lessonId: { userId, lessonId } } });

test("completedAt is written once, survives re-saves and races, and is never invented", { skip: skipReason }, async () => {
  const { raiseLessonProgress } = await import("../src/lib/lesson-progress");
  const w = await world();
  const [l1, l2] = w.lessons;
  const user = w.learners[0];
  try {
    // Not complete yet: no time.
    await raiseLessonProgress(w.prisma, { userId: user.id }, { lessonId: l1.id, lastPositionSeconds: 10, isCompleted: false });
    assert.equal((await row(w, user.id, l1.id)).completedAt, null);

    // The write that completes it sets the time.
    const before = Date.now();
    await raiseLessonProgress(w.prisma, { userId: user.id }, { lessonId: l1.id, lastPositionSeconds: 90, isCompleted: true });
    const first = (await row(w, user.id, l1.id)).completedAt!;
    assert.ok(first.getTime() >= before - 1000 && first.getTime() <= Date.now() + 1000);

    // Re-watching and re-saving, even much later, never moves it.
    await new Promise((r) => setTimeout(r, 20));
    await raiseLessonProgress(w.prisma, { userId: user.id }, { lessonId: l1.id, lastPositionSeconds: 5, isCompleted: true });
    await raiseLessonProgress(w.prisma, { userId: user.id }, { lessonId: l1.id, lastPositionSeconds: 200, isCompleted: false });
    const again = await row(w, user.id, l1.id);
    assert.equal(again.completedAt!.getTime(), first.getTime());
    assert.equal(again.isCompleted, true, "completion never reverts");

    // Twenty concurrent completing saves: one time, identical for everyone.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => raiseLessonProgress(w.prisma, { userId: user.id }, { lessonId: l2.id, lastPositionSeconds: 30, isCompleted: true })),
    );
    const times = new Set(results.map((r) => r.completedAt?.getTime()));
    assert.equal(times.size, 1);
    assert.equal((await row(w, user.id, l2.id)).completedAt!.getTime(), [...times][0]);

    // A historical completed row (no recorded time) stays unknown when saved again.
    const old = await w.prisma.lessonProgress.create({ data: { userId: w.learners[1].id, lessonId: l1.id, isCompleted: true } });
    await raiseLessonProgress(w.prisma, { userId: w.learners[1].id }, { lessonId: l1.id, lastPositionSeconds: 10, isCompleted: true });
    assert.equal((await w.prisma.lessonProgress.findUniqueOrThrow({ where: { id: old.id } })).completedAt, null);
  } finally {
    await cleanup(w);
  }
});

test("a sign-in transfer keeps the earliest known completion time and fabricates none", { skip: skipReason }, async () => {
  const { transferAnonymousState } = await import("../src/lib/anonymous-transfer");
  const w = await world();
  const [l1, l2, l3, l4] = w.lessons;
  const user = w.learners[0];
  const early = new Date("2026-01-10T10:00:00.000Z");
  const late = new Date("2026-03-10T10:00:00.000Z");
  const session = sid();
  try {
    await w.prisma.userSession.create({ data: { id: session, anonKey: session } });
    w.sessions.push(session);
    const anon = (lessonId: string, completedAt: Date | null, isCompleted = true) =>
      w.prisma.lessonProgress.create({ data: { sessionId: session, lessonId, isCompleted, completedAt, lastPositionSeconds: 5 } });
    await anon(l1.id, early);                    // anonymous earlier than account
    await anon(l2.id, late);                     // anonymous later than account
    await anon(l3.id, null);                     // anonymous completed before the column existed
    await anon(l4.id, null, false);              // not completed
    await w.prisma.lessonProgress.create({ data: { userId: user.id, lessonId: l1.id, isCompleted: true, completedAt: late } });
    await w.prisma.lessonProgress.create({ data: { userId: user.id, lessonId: l2.id, isCompleted: true, completedAt: early } });
    await w.prisma.lessonProgress.create({ data: { userId: user.id, lessonId: l4.id, isCompleted: false } });

    const result = await transferAnonymousState({ userId: user.id, userEmail: null, sessionId: session });
    assert.equal(result.status, "complete");
    assert.equal((await row(w, user.id, l1.id)).completedAt!.getTime(), early.getTime(), "earliest wins");
    assert.equal((await row(w, user.id, l2.id)).completedAt!.getTime(), early.getTime(), "account's earlier time kept");
    const third = await row(w, user.id, l3.id);
    assert.equal(third.isCompleted, true);
    assert.equal(third.completedAt, null, "unknown stays unknown");
    assert.equal((await row(w, user.id, l4.id)).completedAt, null);

    // An account row completed before the column existed stays "unknown" when a later anonymous completion transfers.
    const session2 = sid();
    await w.prisma.userSession.create({ data: { id: session2, anonKey: session2 } });
    w.sessions.push(session2);
    const second = w.learners[1];
    await w.prisma.lessonProgress.create({ data: { userId: second.id, lessonId: l1.id, isCompleted: true } }); // historical, unknown time
    await w.prisma.lessonProgress.create({ data: { sessionId: session2, lessonId: l1.id, isCompleted: true, completedAt: late, lastPositionSeconds: 3 } });
    await transferAnonymousState({ userId: second.id, userEmail: null, sessionId: session2 });
    assert.equal((await row(w, second.id, l1.id)).completedAt, null, "no date is invented for a historical completion");
  } finally {
    await cleanup(w);
  }
});

test("creator analytics counts completions by completedAt, separates unknown dates and excludes the owner", { skip: skipReason }, async () => {
  const { creatorAnalyticsGetImpl } = await import("../src/app/api/creator/analytics/route");
  const w = await world();
  const [l1, l2, l3] = w.lessons;
  const jan = new Date("2026-01-15T12:00:00.000Z");
  const feb = new Date("2026-02-15T12:00:00.000Z");
  try {
    const progress = (userId: string | null, lessonId: string, completedAt: Date | null, extra: object = {}) =>
      w.prisma.lessonProgress.create({ data: { userId, lessonId, isCompleted: true, completedAt, ...extra } });
    // Learner 0: completed in January, then re-watched in February (updatedAt moves, completedAt does not).
    const a = await progress(w.learners[0].id, l1.id, jan);
    await w.prisma.lessonProgress.update({ where: { id: a.id }, data: { lastPositionSeconds: 50, updatedAt: feb } });
    await progress(w.learners[1].id, l1.id, feb);   // February
    await progress(w.learners[1].id, l2.id, null);  // historical: date not recorded
    await progress(w.owner.id, l3.id, feb);         // the owner: never a learner
    await progress(w.owner.id, l2.id, null);

    const asCreator = async () => ({ userId: w.owner.id, creatorProfile: { id: w.profile.id, userId: w.owner.id, displayName: null } });
    const totals = async (from: string, to: string) => {
      const response = await creatorAnalyticsGetImpl(new NextRequest(`http://localhost/api/creator/analytics?dateFrom=${from}&dateTo=${to}`), asCreator as never);
      assert.equal(response.status, 200);
      return (await response.json()).data.totals as { lessonsCompletedInPeriod: number; lessonsCurrentlyComplete: number; completionDateNotRecorded: number };
    };
    const january = await totals("2026-01-01", "2026-01-31");
    assert.equal(january.lessonsCompletedInPeriod, 1, "completed last month and re-watched later counts in January only");
    const february = await totals("2026-02-01", "2026-02-28");
    assert.equal(february.lessonsCompletedInPeriod, 1, "the re-watch does not count; the owner does not count");
    for (const t of [january, february]) {
      assert.equal(t.lessonsCurrentlyComplete, 3, "three learner rows are complete now; owner rows excluded");
      assert.equal(t.completionDateNotRecorded, 1);
    }
  } finally {
    await cleanup(w);
  }
});
