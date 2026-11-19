import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";

type Db = Prisma.TransactionClient | typeof prisma;

export type LessonProgressOwner = { userId: string } | { sessionId: string };

export type LessonProgressSnapshot = {
  lessonId: string;
  lastPositionSeconds: number;
  isCompleted: boolean;
  completedAt: Date | null;
  updatedAt: Date;
};

const SNAPSHOT_SELECT = {
  lessonId: true,
  lastPositionSeconds: true,
  isCompleted: true,
  completedAt: true,
  updatedAt: true,
} as const;

function ownerWhere(owner: LessonProgressOwner, lessonId: string) {
  return "userId" in owner
    ? { userId: owner.userId, lessonId }
    : { sessionId: owner.sessionId, lessonId };
}

/**
 * Raise-only progress write.
 *
 * Every statement here can only move a row forward: the position never
 * decreases and `isCompleted` never goes from true to false. Because each
 * statement is conditional and atomic, two concurrent writers (a progress save
 * and an anonymous transfer, or two transfers) cannot lose each other's update,
 * which a read-then-write `max()` cannot guarantee.
 *
 * `completedAt` is written exactly once, by the statement that flips
 * `isCompleted` from false to true (that statement's `isCompleted: false`
 * condition makes it set-once under concurrency). A sign-in transfer passes the
 * anonymous row's own `completedAt`; the earliest KNOWN time wins, and a row with
 * no recorded time is never given a made-up one.
 */
export async function raiseLessonProgress(
  db: Db,
  owner: LessonProgressOwner,
  input: { lessonId: string; lastPositionSeconds: number; isCompleted: boolean; completedAt?: Date | null },
): Promise<LessonProgressSnapshot> {
  const position = Math.max(0, Math.floor(Number.isFinite(input.lastPositionSeconds) ? input.lastPositionSeconds : 0));
  const where = ownerWhere(owner, input.lessonId);
  // A transfer carries the source row's time (possibly null = unknown); a fresh save is "now".
  const completionTime = (): Date | null =>
    input.isCompleted ? (input.completedAt === undefined ? new Date() : input.completedAt) : null;

  await db.lessonProgress.createMany({
    data: [{ ...where, lastPositionSeconds: position, isCompleted: input.isCompleted, completedAt: completionTime() }],
    skipDuplicates: true,
  });
  if (position > 0) {
    await db.lessonProgress.updateMany({
      where: { ...where, lastPositionSeconds: { lt: position } },
      data: { lastPositionSeconds: position },
    });
  }
  if (input.isCompleted) {
    // The `isCompleted: false` condition is what makes completedAt set-once.
    await db.lessonProgress.updateMany({
      where: { ...where, isCompleted: false },
      data: { isCompleted: true, completedAt: completionTime() },
    });
    // Transfer only: if the existing row has a LATER known time, take the earlier one. A row
    // whose time is unknown (completed before the column existed) stays unknown: a later
    // anonymous completion must not give it a made-up date.
    if (input.completedAt) {
      await db.lessonProgress.updateMany({
        where: { ...where, isCompleted: true, completedAt: { gt: input.completedAt } },
        data: { completedAt: input.completedAt },
      });
    }
  }

  const row = await db.lessonProgress.findFirst({ where, select: SNAPSHOT_SELECT });
  if (row) return row;

  // Only an anonymous row can vanish here: a concurrent sign-in transfer claimed
  // and deleted it after the create above, so the conditional updates above hit
  // nothing. Recreate it with this write's values; the next transfer moves it.
  // Never report a save that was not stored.
  if ("sessionId" in owner) {
    await db.lessonProgress.createMany({
      data: [{ ...where, lastPositionSeconds: position, isCompleted: input.isCompleted, completedAt: completionTime() }],
      skipDuplicates: true,
    });
    const recreated = await db.lessonProgress.findFirst({ where, select: SNAPSHOT_SELECT });
    if (recreated) return recreated;
  }
  throw new Error("Lesson progress could not be saved.");
}
