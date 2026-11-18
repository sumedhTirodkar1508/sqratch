import type { Prisma, PrismaClient } from "@prisma/client";
import { resolveLessonVideoStorageReference } from "@/lib/lesson-video-reference";
import { attachLessonVideo, releaseLessonVideos, type StorageObject } from "@/lib/staged-assets";

/**
 * Lesson writes that change or drop a video object. Each runs in one transaction
 * together with its staged-asset claims and returns the ids of rows now claimed
 * for cleanup; the caller deletes from storage after commit (settleClaimedAssets)
 * and the sweeper retries failures.
 */
const lessonReturnSelect = {
  id: true, title: true, description: true, sortOrder: true,
  completionPointsReward: true, videoSource: true, youtubeUrl: true,
  videoUploadUrl: true, videoStorageBucket: true, videoStoragePath: true,
} satisfies Prisma.LessonSelect;

const videoColumns = { videoUploadUrl: true, videoStorageBucket: true, videoStoragePath: true } as const;

export async function saveLessonWithVideo(
  db: PrismaClient,
  input: {
    lessonId: string;
    courseId: string;
    experienceSlug: string;
    ownerUserId: string;
    /** The new upload (already validated), or null for a non-upload lesson. */
    videoReference: StorageObject | null;
    data: Omit<Prisma.LessonUncheckedUpdateInput, "videoUploadUrl" | "videoStorageBucket" | "videoStoragePath">;
  },
) {
  return db.$transaction(async (tx) => {
    // Lock the lesson and read its CURRENT video: a concurrent save may have changed it.
    await tx.$queryRaw`SELECT id FROM "Lesson" WHERE id = ${input.lessonId} FOR UPDATE`;
    const current = await tx.lesson.findUniqueOrThrow({ where: { id: input.lessonId }, select: videoColumns });
    const oldReference = resolveLessonVideoStorageReference({
      lesson: current,
      courseId: input.courseId,
      experienceSlug: input.experienceSlug,
    });
    if (input.videoReference) {
      await attachLessonVideo(tx, {
        object: input.videoReference,
        lessonId: input.lessonId,
        courseId: input.courseId,
        ownerUserId: input.ownerUserId,
      });
    }
    const lesson = await tx.lesson.update({
      where: { id: input.lessonId },
      data: {
        ...input.data,
        videoUploadUrl: null,
        videoStorageBucket: input.videoReference?.bucket || null,
        videoStoragePath: input.videoReference?.path || null,
      },
      select: lessonReturnSelect,
    });
    const claimedIds = await releaseLessonVideos(tx, {
      lessonId: input.lessonId,
      ownerUserId: input.ownerUserId,
      keep: input.videoReference,
      legacyOld: oldReference,
    });
    return { lesson, claimedIds };
  });
}

export async function deleteLessonReleasingVideo(
  db: PrismaClient,
  input: { lessonId: string; courseId: string; experienceSlug: string; ownerUserId: string },
) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Lesson" WHERE id = ${input.lessonId} FOR UPDATE`;
    const current = await tx.lesson.findUnique({ where: { id: input.lessonId }, select: videoColumns });
    if (!current) return [] as string[];
    const reference = resolveLessonVideoStorageReference({
      lesson: current,
      courseId: input.courseId,
      experienceSlug: input.experienceSlug,
    });
    await tx.lesson.delete({ where: { id: input.lessonId } });
    return releaseLessonVideos(tx, { lessonId: input.lessonId, ownerUserId: input.ownerUserId, legacyOld: reference });
  });
}

/** The course delete cascades to its lessons; their videos are released in the same transaction. */
export async function deleteCourseReleasingVideos(
  db: PrismaClient,
  input: { courseId: string; experienceSlug: string; ownerUserId: string },
) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Course" WHERE id = ${input.courseId} FOR UPDATE`;
    const lessons = await tx.lesson.findMany({
      where: { courseId: input.courseId },
      select: { id: true, ...videoColumns },
    });
    await tx.course.delete({ where: { id: input.courseId } });
    const claimedIds: string[] = [];
    for (const lesson of lessons) {
      const legacyOld = resolveLessonVideoStorageReference({
        lesson,
        courseId: input.courseId,
        experienceSlug: input.experienceSlug,
      });
      claimedIds.push(...(await releaseLessonVideos(tx, { lessonId: lesson.id, ownerUserId: input.ownerUserId, legacyOld })));
    }
    return claimedIds;
  });
}
