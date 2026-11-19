import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { attachLessonVideo } from "@/lib/staged-assets";

const lessonSelect = {
  id: true, title: true, description: true, sortOrder: true,
  completionPointsReward: true, videoSource: true, youtubeUrl: true,
  videoUploadUrl: true, videoStorageBucket: true, videoStoragePath: true,
} satisfies Prisma.LessonSelect;

/**
 * Serialize creates for a course so concurrent retries of an upload share one lesson.
 * An uploaded video is claimed (STAGED -> ATTACHED) in the same transaction as the
 * lesson, so the upload can never be cleaned up out from under a saved lesson.
 * Throws AssetUnavailableError (rolling everything back) when the upload was
 * already claimed for cleanup or belongs to another lesson.
 */
export async function createLessonOnce(data: Prisma.LessonUncheckedCreateInput, ownerUserId: string) {
  if (data.videoSource !== "UPLOAD" || !data.videoStorageBucket || !data.videoStoragePath) {
    return { lesson: await prisma.lesson.create({ data, select: lessonSelect }), created: true };
  }
  const object = { bucket: data.videoStorageBucket, path: data.videoStoragePath };
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Course" WHERE id = ${data.courseId} FOR UPDATE`;
    const existing = await tx.lesson.findFirst({ where: { courseId: data.courseId, videoStorageBucket: object.bucket, videoStoragePath: object.path }, select: lessonSelect });
    if (existing) {
      await attachLessonVideo(tx, { object, lessonId: existing.id, courseId: data.courseId, ownerUserId });
      return { lesson: existing, created: false };
    }
    const lesson = await tx.lesson.create({ data, select: lessonSelect });
    await attachLessonVideo(tx, { object, lessonId: lesson.id, courseId: data.courseId, ownerUserId });
    return { lesson, created: true };
  });
}
