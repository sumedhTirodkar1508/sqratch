import type { Prisma, PrismaClient } from "@prisma/client";
import { resolveLessonVideoStorageReference } from "@/lib/lesson-video-reference";

/**
 * Ownership of uploaded lesson-video objects.
 *
 * One `StagedAsset` row per object. Every transition is a conditional update on
 * that row, so attachment and cleanup cannot both win:
 *   STAGED -> ATTACHED          (a lesson save claims the upload)
 *   STAGED -> CLEANUP_CLAIMED   (client cleanup, or the sweeper for an abandoned upload)
 *   ATTACHED -> CLEANUP_CLAIMED (the lesson dropped or replaced the video)
 *   CLEANUP_CLAIMED -> DELETED  (storage confirmed the object is gone)
 * A claimed row never goes back to STAGED/ATTACHED, and claims for lesson changes
 * run inside the same transaction as the change, so a crash cannot leak an object.
 * Storage deletion happens after commit and is retried by the sweeper.
 */
type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaClient;
export type StorageObject = { bucket: string; path: string };

export const STAGED_ASSET_KIND = "LESSON_VIDEO";
export const DEFAULT_STAGED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_CLEANUP_ATTEMPTS = 10;

export class AssetUnavailableError extends Error {
  readonly code = "ASSET_UNAVAILABLE";
  constructor() {
    super("The uploaded lesson video is no longer available. Please upload it again.");
    this.name = "AssetUnavailableError";
  }
}

/** Records an upload at the moment its signed URL is issued. Idempotent. */
export async function stageUpload(db: Db, input: StorageObject & { ownerUserId: string; courseId: string }) {
  await db.stagedAsset.createMany({
    data: [{ bucket: input.bucket, path: input.path, ownerUserId: input.ownerUserId, courseId: input.courseId, kind: STAGED_ASSET_KIND }],
    skipDuplicates: true,
  });
}

/** True when a lesson other than `exceptLessonId` still points at the object (new or legacy columns). */
async function otherLessonReferences(tx: Tx, object: StorageObject, exceptLessonId?: string) {
  const notSelf = exceptLessonId ? { id: { not: exceptLessonId } } : {};
  if (await tx.lesson.count({ where: { ...notSelf, videoStorageBucket: object.bucket, videoStoragePath: object.path } })) return true;
  // Legacy lessons only carry a public URL that contains the object path.
  const legacy = await tx.lesson.findMany({
    where: { ...notSelf, videoStorageBucket: null, videoStoragePath: null, videoUploadUrl: { contains: object.path } },
    select: { videoUploadUrl: true, courseId: true, course: { select: { experience: { select: { slug: true } } } } },
  });
  return legacy.some((lesson) => {
    const reference = resolveLessonVideoStorageReference({
      lesson: { videoUploadUrl: lesson.videoUploadUrl },
      courseId: lesson.courseId,
      experienceSlug: lesson.course.experience.slug,
    });
    return reference?.bucket === object.bucket && reference.path === object.path;
  });
}

/**
 * Claims the upload for a lesson. Idempotent for the same lesson (a retried save
 * after a lost response). Throws AssetUnavailableError when the object was
 * claimed for cleanup, deleted, or already belongs to another lesson.
 */
export async function attachLessonVideo(
  tx: Tx,
  input: { object: StorageObject; lessonId: string; courseId: string; ownerUserId: string; now?: Date },
) {
  const { object, lessonId, courseId, ownerUserId } = input;
  const now = input.now ?? new Date();
  const claimed = await tx.stagedAsset.updateMany({
    where: { bucket: object.bucket, path: object.path, status: "STAGED", courseId },
    data: { status: "ATTACHED", lessonId, attachedAt: now },
  });
  if (claimed.count === 1) return;

  let row = await tx.stagedAsset.findUnique({ where: { bucket_path: object } });
  if (!row) {
    // An upload authorized before this release has no row. Adopt it only if no
    // other lesson uses it; ON CONFLICT DO NOTHING keeps a concurrent adopter from aborting us.
    if (await otherLessonReferences(tx, object, lessonId)) throw new AssetUnavailableError();
    await tx.stagedAsset.createMany({
      data: [{ ...object, kind: STAGED_ASSET_KIND, ownerUserId, courseId, lessonId, status: "ATTACHED", attachedAt: now }],
      skipDuplicates: true,
    });
    row = await tx.stagedAsset.findUnique({ where: { bucket_path: object } });
  }
  if (row?.status === "ATTACHED" && row.lessonId === lessonId) return;
  // Adopted by the sweeper through a legacy reference (no lesson id recorded): this lesson claims it.
  if (row?.status === "ATTACHED" && row.lessonId === null) {
    const adopted = await tx.stagedAsset.updateMany({ where: { id: row.id, status: "ATTACHED", lessonId: null }, data: { lessonId, attachedAt: now } });
    if (adopted.count === 1) return;
  }
  throw new AssetUnavailableError();
}

/**
 * Releases the lesson's video objects for cleanup, except `keep`. Skips any
 * object another lesson still references. `legacyOld` is the lesson's previous
 * reference when it predates staged rows. Returns the ids of rows now claimed.
 */
export async function releaseLessonVideos(
  tx: Tx,
  input: { lessonId: string; ownerUserId: string; keep?: StorageObject | null; legacyOld?: StorageObject | null; now?: Date },
): Promise<string[]> {
  const { lessonId, keep, legacyOld, ownerUserId } = input;
  const now = input.now ?? new Date();
  const same = (a: StorageObject, b?: StorageObject | null) => Boolean(b) && a.bucket === b!.bucket && a.path === b!.path;
  const claimedIds: string[] = [];

  const attached = await tx.stagedAsset.findMany({ where: { lessonId, status: "ATTACHED" } });
  for (const row of attached) {
    if (same(row, keep)) continue;
    if (await otherLessonReferences(tx, row, lessonId)) continue;
    const result = await tx.stagedAsset.updateMany({
      where: { id: row.id, status: "ATTACHED", lessonId },
      data: { status: "CLEANUP_CLAIMED", cleanupClaimedAt: now },
    });
    if (result.count === 1) claimedIds.push(row.id);
  }

  if (legacyOld && !same(legacyOld, keep)) {
    const existing = await tx.stagedAsset.findUnique({ where: { bucket_path: legacyOld } });
    // A row means it was handled above, or belongs to another lesson: never insert over it.
    if (!existing && !(await otherLessonReferences(tx, legacyOld, lessonId))) {
      await tx.stagedAsset.createMany({
        data: [{ ...legacyOld, kind: STAGED_ASSET_KIND, ownerUserId, courseId: courseIdFromPath(legacyOld.path), lessonId, status: "CLEANUP_CLAIMED", cleanupClaimedAt: now }],
        skipDuplicates: true,
      });
      const inserted = await tx.stagedAsset.findUnique({ where: { bucket_path: legacyOld } });
      if (inserted?.status === "CLEANUP_CLAIMED" && inserted.lessonId === lessonId) claimedIds.push(inserted.id);
    }
  }
  return claimedIds;
}

/** Upload paths are `experiences/<slug>/courses/<courseId>/lessons/<file>`. */
function courseIdFromPath(path: string) {
  return /\/courses\/([^/]+)\/lessons\//.exec(path)?.[1] ?? "unknown";
}

export type CleanupRequestResult = { ok: true; claimedId: string | null } | { ok: false; reason: "IN_USE" };

/**
 * A client (or admin) asks to remove an upload that is not attached. Never
 * deletes directly: it claims the row, and storage deletion follows. Attached
 * or referenced objects are refused.
 */
export async function requestStagedCleanup(
  db: PrismaClient,
  input: { object: StorageObject; ownerUserId: string; courseId?: string; anyOwner?: boolean; now?: Date },
): Promise<CleanupRequestResult> {
  const { object, ownerUserId } = input;
  const now = input.now ?? new Date();
  return db.$transaction(async (tx) => {
    // A lesson that references the object (for example saved by an older application
    // instance that never attached it) always wins: nothing is claimed or deleted.
    if (await otherLessonReferences(tx, object)) return { ok: false as const, reason: "IN_USE" as const };
    const claimed = await tx.stagedAsset.updateMany({
      where: { ...object, status: "STAGED", ...(input.anyOwner ? {} : { ownerUserId }) },
      data: { status: "CLEANUP_CLAIMED", cleanupClaimedAt: now },
    });
    let row = await tx.stagedAsset.findUnique({ where: { bucket_path: object } });
    if (claimed.count === 1) return { ok: true as const, claimedId: row?.id ?? null };
    if (!row) {
      if (await otherLessonReferences(tx, object)) return { ok: false as const, reason: "IN_USE" as const };
      await tx.stagedAsset.createMany({
        data: [{ ...object, kind: STAGED_ASSET_KIND, ownerUserId, courseId: input.courseId ?? courseIdFromPath(object.path), status: "CLEANUP_CLAIMED", cleanupClaimedAt: now }],
        skipDuplicates: true,
      });
      row = await tx.stagedAsset.findUnique({ where: { bucket_path: object } });
    }
    if (row?.status === "CLEANUP_CLAIMED") return { ok: true as const, claimedId: row.id };
    if (row?.status === "DELETED") return { ok: true as const, claimedId: null };
    return { ok: false as const, reason: "IN_USE" as const };
  });
}

export type DeleteObject = (bucket: string, path: string) => Promise<boolean>;

/** Deletes one claimed object. Success (or "already gone") marks it DELETED; a failure counts an attempt. */
async function deleteClaimed(db: Db, row: { id: string; bucket: string; path: string }, deleteObject: DeleteObject, now: Date) {
  try {
    // Last check before the irreversible step: a lesson now references the object, so keep it.
    if (await otherLessonReferences(db as Tx, row)) {
      const lesson = await db.lesson.findFirst({ where: { videoStorageBucket: row.bucket, videoStoragePath: row.path }, select: { id: true } });
      await db.stagedAsset.updateMany({ where: { id: row.id, status: "CLEANUP_CLAIMED" }, data: { status: "ATTACHED", lessonId: lesson?.id ?? null, attachedAt: now } });
      return false;
    }
    if (await deleteObject(row.bucket, row.path)) {
      await db.stagedAsset.updateMany({
        where: { id: row.id, status: "CLEANUP_CLAIMED" },
        data: { status: "DELETED", deletedAt: now, lastError: null },
      });
      return true;
    }
    await db.stagedAsset.updateMany({
      where: { id: row.id, status: "CLEANUP_CLAIMED" },
      data: { attempts: { increment: 1 }, lastError: "Storage refused the delete." },
    });
  } catch {
    await db.stagedAsset
      .updateMany({ where: { id: row.id, status: "CLEANUP_CLAIMED" }, data: { attempts: { increment: 1 }, lastError: "Storage delete failed." } })
      .catch(() => undefined);
  }
  return false;
}

/** Best-effort deletion right after commit for rows this request claimed. The sweeper retries failures. */
export async function settleClaimedAssets(db: PrismaClient, ids: string[], deleteObject: DeleteObject, now = new Date()) {
  let deleted = 0;
  for (const id of ids) {
    const row = await db.stagedAsset.findFirst({ where: { id, status: "CLEANUP_CLAIMED" }, select: { id: true, bucket: true, path: true } });
    if (row && (await deleteClaimed(db, row, deleteObject, now))) deleted += 1;
  }
  return deleted;
}

export type SweepResult = { claimedStale: number; deleted: number; failed: number; exhausted: number };

/**
 * One bounded sweep: claim abandoned uploads (STAGED past the age limit), then
 * delete a batch of claimed objects. Safe to run concurrently or repeatedly;
 * deleting an already-deleted object is a no-op. Rows that keep failing stop
 * being retried after MAX_CLEANUP_ATTEMPTS and stay visible with `lastError`.
 */
export async function sweepStagedAssets(
  db: PrismaClient,
  deps: { deleteObject: DeleteObject; now?: Date; stagedMaxAgeMs?: number; batchSize?: number; maxAttempts?: number },
): Promise<SweepResult> {
  const now = deps.now ?? new Date();
  const batchSize = deps.batchSize ?? 50;
  const maxAttempts = deps.maxAttempts ?? MAX_CLEANUP_ATTEMPTS;
  const cutoff = new Date(now.getTime() - (deps.stagedMaxAgeMs ?? DEFAULT_STAGED_MAX_AGE_MS));

  const stale = await db.stagedAsset.findMany({
    where: { status: "STAGED", createdAt: { lt: cutoff } },
    orderBy: { createdAt: "asc" },
    take: batchSize,
    select: { id: true, bucket: true, path: true },
  });
  let claimedStale = 0;
  for (const row of stale) {
    // An old application instance (rolling deploy or rollback) can save a lesson without
    // ever attaching its upload. A referenced object is adopted, never claimed for deletion.
    claimedStale += await db.$transaction(async (tx) => {
      const lesson = await tx.lesson.findFirst({
        where: { videoStorageBucket: row.bucket, videoStoragePath: row.path },
        select: { id: true },
      });
      if (lesson || (await otherLessonReferences(tx, row))) {
        await tx.stagedAsset.updateMany({
          where: { id: row.id, status: "STAGED" },
          data: { status: "ATTACHED", lessonId: lesson?.id ?? null, attachedAt: now },
        });
        return 0;
      }
      const result = await tx.stagedAsset.updateMany({
        where: { id: row.id, status: "STAGED" },
        data: { status: "CLEANUP_CLAIMED", cleanupClaimedAt: now },
      });
      return result.count;
    });
  }
  const claimed = { count: claimedStale };

  const rows = await db.stagedAsset.findMany({
    where: { status: "CLEANUP_CLAIMED", attempts: { lt: maxAttempts } },
    orderBy: [{ attempts: "asc" }, { cleanupClaimedAt: "asc" }],
    take: batchSize,
    select: { id: true, bucket: true, path: true },
  });
  let deleted = 0;
  let failed = 0;
  for (const row of rows) {
    if (await deleteClaimed(db, row, deps.deleteObject, now)) deleted += 1;
    else failed += 1;
  }
  const exhausted = await db.stagedAsset.count({ where: { status: "CLEANUP_CLAIMED", attempts: { gte: maxAttempts } } });
  return { claimedStale: claimed.count, deleted, failed, exhausted };
}
