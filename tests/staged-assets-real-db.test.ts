import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realDbTest } from "./helpers/real-db";

const { skipReason } = realDbTest("STAGED_ASSETS_REAL_DB");

// Nothing here may reach a real storage service.
process.env.SUPABASE_STORAGE_URL = "https://storage.invalid.test";
process.env.SUPABASE_STORAGE_SERVICE_ROLE_KEY = "test-key";
const BUCKET = process.env.SUPABASE_LESSON_VIDEO_BUCKET || "lesson-videos";

async function world() {
  const { default: prisma } = await import("../src/lib/prisma");
  const key = randomUUID();
  const user = await prisma.user.create({ data: { email: `${key}@example.test`, role: "CREATOR" } });
  const creator = await prisma.creatorProfile.create({ data: { userId: user.id } });
  const slug = `exp-${key}`;
  const experience = await prisma.experience.create({ data: { creatorId: creator.id, title: key, slug } });
  const course = await prisma.course.create({ data: { experienceId: experience.id, title: key } });
  const path = (name: string) => `experiences/${slug}/courses/${course.id}/lessons/${key}-${name}.mp4`;
  const lesson = (extra: Record<string, unknown> = {}) =>
    prisma.lesson.create({ data: { courseId: course.id, title: "Lesson", videoSource: "UPLOAD", ...extra } });
  const stage = (name: string, createdAt?: Date) =>
    prisma.stagedAsset.create({ data: { bucket: BUCKET, path: path(name), ownerUserId: user.id, courseId: course.id, createdAt } });
  const rowOf = (name: string) => prisma.stagedAsset.findUnique({ where: { bucket_path: { bucket: BUCKET, path: path(name) } } });
  const ref = (name: string) => ({ bucket: BUCKET, path: path(name) });
  return { prisma, key, user, creator, experience, course, slug, path, lesson, stage, rowOf, ref };
}
type World = Awaited<ReturnType<typeof world>>;

async function cleanup(w: World) {
  await w.prisma.stagedAsset.deleteMany({ where: { ownerUserId: w.user.id } });
  await w.prisma.experience.deleteMany({ where: { id: w.experience.id } });
  await w.prisma.creatorProfile.deleteMany({ where: { id: w.creator.id } });
  await w.prisma.user.deleteMany({ where: { id: w.user.id } });
}

const lessonData = { title: "Lesson", description: null, sortOrder: 0, completionPointsReward: 0, videoSource: "UPLOAD" as const, youtubeUrl: null };

test("attach and sweeper claim race: exactly one wins and an attached object is never deleted", { skip: skipReason }, async () => {
  const { attachLessonVideo, sweepStagedAssets, AssetUnavailableError } = await import("../src/lib/staged-assets");
  const w = await world();
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const deleted: string[] = [];
  try {
    for (let i = 0; i < 12; i += 1) {
      const name = `race${i}`;
      await w.stage(name, old);
      const lesson = await w.lesson();
      const attach = w.prisma
        .$transaction((tx) => attachLessonVideo(tx, { object: w.ref(name), lessonId: lesson.id, courseId: w.course.id, ownerUserId: w.user.id }))
        .then(() => "attached" as const, (e) => (e instanceof AssetUnavailableError ? ("unavailable" as const) : Promise.reject(e)));
      const sweep = sweepStagedAssets(w.prisma, { deleteObject: async (_b, path) => (deleted.push(path), true), batchSize: 200 });
      const [outcome] = await Promise.all([attach, sweep]);
      const row = (await w.rowOf(name))!;
      if (outcome === "attached") {
        assert.equal(row.status, "ATTACHED", `iteration ${i}`);
        assert.equal(row.lessonId, lesson.id);
        assert.ok(!deleted.includes(w.path(name)), "an attached object must never be deleted");
      } else {
        assert.ok(["CLEANUP_CLAIMED", "DELETED"].includes(row.status), `iteration ${i}: ${row.status}`);
        assert.equal(row.lessonId, null);
      }
    }
  } finally {
    await cleanup(w);
  }
});

test("the sweeper adopts, never deletes, an old upload that a lesson already references", { skip: skipReason }, async () => {
  const { sweepStagedAssets } = await import("../src/lib/staged-assets");
  const w = await world();
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const deleted: string[] = [];
  try {
    await w.stage("used", old);
    await w.stage("abandoned", old);
    const lesson = await w.lesson({ videoStorageBucket: BUCKET, videoStoragePath: w.path("used") }); // saved by an old app instance, never attached
    await sweepStagedAssets(w.prisma, { deleteObject: async (_b, path) => (deleted.push(path), true), batchSize: 200 });
    const used = (await w.rowOf("used"))!;
    assert.equal(used.status, "ATTACHED");
    assert.equal(used.lessonId, lesson.id);
    assert.ok(!deleted.includes(w.path("used")), "an object a lesson uses is never deleted");
    assert.equal((await w.rowOf("abandoned"))!.status, "DELETED");
  } finally {
    await cleanup(w);
  }
});

test("an upload an older app instance saved on a lesson is never claimed or deleted, and the lesson can still be re-saved", { skip: skipReason }, async () => {
  const { requestStagedCleanup, sweepStagedAssets } = await import("../src/lib/staged-assets");
  const { saveLessonWithVideo } = await import("../src/lib/lesson-video-lifecycle");
  const { getPublicStorageUrl } = await import("../src/lib/storage-upload");
  const w = await world();
  const deleted: string[] = [];
  const del = async (_b: string, p: string) => (deleted.push(p), true);
  try {
    // Saved by an old instance: the lesson references the object, its row is still STAGED.
    await w.stage("oldapp");
    const lesson = await w.lesson({ videoStorageBucket: BUCKET, videoStoragePath: w.path("oldapp") });
    assert.deepEqual(await requestStagedCleanup(w.prisma, { object: w.ref("oldapp"), ownerUserId: w.user.id }), { ok: false, reason: "IN_USE" });
    assert.deepEqual(await requestStagedCleanup(w.prisma, { object: w.ref("oldapp"), ownerUserId: "admin", anyOwner: true }), { ok: false, reason: "IN_USE" });
    assert.equal((await w.rowOf("oldapp"))!.status, "STAGED");

    // A row claimed before the lesson referenced it is re-checked at deletion time and kept.
    await w.stage("late");
    await w.prisma.stagedAsset.update({ where: { bucket_path: { bucket: BUCKET, path: w.path("late") } }, data: { status: "CLEANUP_CLAIMED", cleanupClaimedAt: new Date() } });
    await w.lesson({ videoStorageBucket: BUCKET, videoStoragePath: w.path("late") });
    await sweepStagedAssets(w.prisma, { deleteObject: del, batchSize: 200 });
    assert.ok(!deleted.includes(w.path("late")), "a referenced claimed object is not deleted");
    assert.equal((await w.rowOf("late"))!.status, "ATTACHED");

    // Adopted through a legacy URL (no lesson id): the new app can still re-save that lesson with the same video.
    await w.stage("legacy", new Date(Date.now() - 48 * 60 * 60 * 1000));
    const legacyLesson = await w.lesson({ videoUploadUrl: getPublicStorageUrl(BUCKET, w.path("legacy")) });
    await sweepStagedAssets(w.prisma, { deleteObject: del, batchSize: 200 });
    const adopted = (await w.rowOf("legacy"))!;
    assert.equal(adopted.status, "ATTACHED");
    assert.equal(adopted.lessonId, null);
    const saved = await saveLessonWithVideo(w.prisma, { lessonId: legacyLesson.id, courseId: w.course.id, experienceSlug: w.slug, ownerUserId: w.user.id, videoReference: w.ref("legacy"), data: lessonData });
    assert.deepEqual(saved.claimedIds, []);
    assert.equal((await w.rowOf("legacy"))!.lessonId, legacyLesson.id);
    assert.ok(lesson.id);
  } finally {
    await cleanup(w);
  }
});

test("a failed storage deletion is retried with an attempt count and stops at the cap", { skip: skipReason }, async () => {
  const { sweepStagedAssets } = await import("../src/lib/staged-assets");
  const w = await world();
  try {
    await w.stage("stuck", new Date(Date.now() - 48 * 60 * 60 * 1000));
    const fail = async () => false;
    const boom = async () => { throw new Error("secret-ish detail that must not be stored"); };
    let r = await sweepStagedAssets(w.prisma, { deleteObject: fail, batchSize: 200, maxAttempts: 3 });
    assert.equal(r.claimedStale >= 1, true);
    let row = (await w.rowOf("stuck"))!;
    assert.equal(row.status, "CLEANUP_CLAIMED");
    assert.equal(row.attempts, 1);
    await sweepStagedAssets(w.prisma, { deleteObject: boom, batchSize: 200, maxAttempts: 3 });
    row = (await w.rowOf("stuck"))!;
    assert.equal(row.attempts, 2);
    assert.equal(row.lastError, "Storage delete failed.", "no raw error text is stored");
    // Third failure reaches the cap: it is no longer retried but stays visible.
    await sweepStagedAssets(w.prisma, { deleteObject: fail, batchSize: 200, maxAttempts: 3 });
    r = await sweepStagedAssets(w.prisma, { deleteObject: fail, batchSize: 200, maxAttempts: 3 });
    row = (await w.rowOf("stuck"))!;
    assert.equal(row.attempts, 3);
    assert.ok(r.exhausted >= 1);
    // A later run with working storage finishes it once the cap is raised.
    const ok = await sweepStagedAssets(w.prisma, { deleteObject: async () => true, batchSize: 200, maxAttempts: 10 });
    assert.ok(ok.deleted >= 1);
    row = (await w.rowOf("stuck"))!;
    assert.equal(row.status, "DELETED");
    assert.ok(row.deletedAt);
  } finally {
    await cleanup(w);
  }
});

test("storage 404 counts as deleted and other failures do not", { skip: skipReason }, async () => {
  const { deleteFileFromStorage } = await import("../src/lib/storage-upload");
  const original = globalThis.fetch;
  try {
    for (const [status, body, expected] of [
      [200, null, true], [404, null, true], [500, null, false], [403, null, false],
      [400, '{"statusCode":"404","error":"not_found","message":"Object not found"}', true],
      [400, '{"statusCode":"400","error":"Bad Request","message":"invalid bucket"}', false],
    ] as const) {
      globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch;
      assert.equal(await deleteFileFromStorage(BUCKET, "a/b.mp4"), expected, `status ${status} ${body ?? ""}`);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("replacing, switching and removing a video claims the old object; an unchanged save claims nothing", { skip: skipReason }, async () => {
  const { saveLessonWithVideo, deleteLessonReleasingVideo } = await import("../src/lib/lesson-video-lifecycle");
  const { settleClaimedAssets } = await import("../src/lib/staged-assets");
  const w = await world();
  const deletedPaths: string[] = [];
  const del = async (_b: string, p: string) => (deletedPaths.push(p), true);
  const save = (lessonId: string, name: string | null, source: "UPLOAD" | "YOUTUBE" = "UPLOAD") =>
    saveLessonWithVideo(w.prisma, {
      lessonId, courseId: w.course.id, experienceSlug: w.slug, ownerUserId: w.user.id,
      videoReference: name ? w.ref(name) : null, data: { ...lessonData, videoSource: source, youtubeUrl: source === "YOUTUBE" ? "https://youtu.be/x" : null },
    });
  try {
    await w.stage("a"); await w.stage("b");
    const lesson = await w.lesson();
    let r = await save(lesson.id, "a");
    assert.deepEqual(r.claimedIds, []);
    assert.equal((await w.rowOf("a"))!.status, "ATTACHED");

    r = await save(lesson.id, "a"); // unchanged video, retried save
    assert.deepEqual(r.claimedIds, []);
    assert.equal((await w.rowOf("a"))!.status, "ATTACHED");

    r = await save(lesson.id, "b"); // replacement: a is released, never deleted inline
    assert.equal(r.claimedIds.length, 1);
    assert.deepEqual(deletedPaths, []);
    assert.equal((await w.rowOf("a"))!.status, "CLEANUP_CLAIMED");
    assert.equal(await settleClaimedAssets(w.prisma, r.claimedIds, del), 1);
    assert.deepEqual(deletedPaths, [w.path("a")]);
    assert.equal((await w.rowOf("a"))!.status, "DELETED");
    assert.equal((await w.rowOf("b"))!.status, "ATTACHED");

    // The released object can never be attached again.
    const { attachLessonVideo, AssetUnavailableError } = await import("../src/lib/staged-assets");
    const other = await w.lesson();
    await assert.rejects(w.prisma.$transaction((tx) => attachLessonVideo(tx, { object: w.ref("a"), lessonId: other.id, courseId: w.course.id, ownerUserId: w.user.id })), AssetUnavailableError);

    r = await save(lesson.id, null, "YOUTUBE"); // switching away from upload releases b
    assert.equal(r.claimedIds.length, 1);
    assert.equal((await w.rowOf("b"))!.status, "CLEANUP_CLAIMED");

    // Removing a lesson releases its video through the same claim.
    await w.stage("c");
    const third = await w.lesson();
    await save(third.id, "c");
    const ids = await deleteLessonReleasingVideo(w.prisma, { lessonId: third.id, courseId: w.course.id, experienceSlug: w.slug, ownerUserId: w.user.id });
    assert.equal(ids.length, 1);
    assert.equal((await w.rowOf("c"))!.status, "CLEANUP_CLAIMED");
    assert.deepEqual(await deleteLessonReleasingVideo(w.prisma, { lessonId: third.id, courseId: w.course.id, experienceSlug: w.slug, ownerUserId: w.user.id }), [], "deleting twice is a no-op");
  } finally {
    await cleanup(w);
  }
});

test("two concurrent saves of one lesson never leave an orphaned ATTACHED object", { skip: skipReason }, async () => {
  const { saveLessonWithVideo } = await import("../src/lib/lesson-video-lifecycle");
  const w = await world();
  const save = (lessonId: string, name: string) =>
    saveLessonWithVideo(w.prisma, { lessonId, courseId: w.course.id, experienceSlug: w.slug, ownerUserId: w.user.id, videoReference: w.ref(name), data: lessonData });
  try {
    for (let i = 0; i < 6; i += 1) {
      const x = `x${i}`, y = `y${i}`, z = `z${i}`;
      await Promise.all([w.stage(x), w.stage(y), w.stage(z)]);
      const lesson = await w.lesson();
      await save(lesson.id, x);
      await Promise.all([save(lesson.id, y), save(lesson.id, z)]);
      const current = await w.prisma.lesson.findUniqueOrThrow({ where: { id: lesson.id } });
      const attached = await w.prisma.stagedAsset.findMany({ where: { lessonId: lesson.id, status: "ATTACHED" } });
      assert.equal(attached.length, 1, `iteration ${i}: exactly one attached object`);
      assert.equal(attached[0].path, current.videoStoragePath, "and it is the one the lesson references");
      assert.equal((await w.rowOf(x))!.status, "CLEANUP_CLAIMED");
      const loser = [y, z].find((n) => w.path(n) !== current.videoStoragePath)!;
      assert.equal((await w.rowOf(loser))!.status, "CLEANUP_CLAIMED", "the replaced upload is released, not orphaned");
    }
  } finally {
    await cleanup(w);
  }
});

test("an object shared with another lesson (new or legacy reference) is never claimed", { skip: skipReason }, async () => {
  const { saveLessonWithVideo } = await import("../src/lib/lesson-video-lifecycle");
  const { releaseLessonVideos, attachLessonVideo, AssetUnavailableError } = await import("../src/lib/staged-assets");
  const { getPublicStorageUrl } = await import("../src/lib/storage-upload");
  const w = await world();
  try {
    // Another lesson still references `shared` by the new columns.
    await w.stage("shared");
    const owner = await w.lesson({ videoStorageBucket: BUCKET, videoStoragePath: w.path("shared") });
    await w.prisma.stagedAsset.update({ where: { bucket_path: { bucket: BUCKET, path: w.path("shared") } }, data: { status: "ATTACHED", lessonId: owner.id } });
    const sharer = await w.lesson({ videoStorageBucket: BUCKET, videoStoragePath: w.path("shared") });
    const ids = await w.prisma.$transaction((tx) => releaseLessonVideos(tx, { lessonId: sharer.id, ownerUserId: w.user.id, legacyOld: w.ref("shared") }));
    assert.deepEqual(ids, []);
    assert.equal((await w.rowOf("shared"))!.status, "ATTACHED");

    // Legacy: an older lesson plays the object through videoUploadUrl and has no staged row of its own.
    const legacyPath = w.path("legacy");
    await w.lesson({ videoUploadUrl: getPublicStorageUrl(BUCKET, legacyPath) });
    const mover = await w.lesson({ videoStorageBucket: BUCKET, videoStoragePath: legacyPath });
    const claimed = await w.prisma.$transaction((tx) => releaseLessonVideos(tx, { lessonId: mover.id, ownerUserId: w.user.id, legacyOld: w.ref("legacy") }));
    assert.deepEqual(claimed, [], "legacy-referenced object is not claimed");
    assert.equal(await w.rowOf("legacy"), null);
    // ...and a lesson cannot adopt an object that another lesson already uses.
    await assert.rejects(
      w.prisma.$transaction((tx) => attachLessonVideo(tx, { object: w.ref("legacy"), lessonId: mover.id, courseId: w.course.id, ownerUserId: w.user.id })),
      AssetUnavailableError,
    );
    // Saving with a pre-existing (row-less) object that nobody else uses adopts it.
    const solo = await w.lesson();
    const r = await saveLessonWithVideo(w.prisma, { lessonId: solo.id, courseId: w.course.id, experienceSlug: w.slug, ownerUserId: w.user.id, videoReference: w.ref("preexisting"), data: lessonData });
    assert.deepEqual(r.claimedIds, []);
    assert.equal((await w.rowOf("preexisting"))!.status, "ATTACHED");
  } finally {
    await cleanup(w);
  }
});

test("concurrent adoption of one pre-existing object by two lessons: one wins, the other is told it is unavailable", { skip: skipReason }, async () => {
  const { attachLessonVideo, AssetUnavailableError } = await import("../src/lib/staged-assets");
  const w = await world();
  try {
    const a = await w.lesson();
    const b = await w.lesson();
    const attach = (lessonId: string) =>
      w.prisma.$transaction((tx) => attachLessonVideo(tx, { object: w.ref("adopt"), lessonId, courseId: w.course.id, ownerUserId: w.user.id })).then(
        () => "ok" as const,
        (error) => (error instanceof AssetUnavailableError ? ("unavailable" as const) : Promise.reject(error)),
      );
    const results = await Promise.all([attach(a.id), attach(b.id)]);
    assert.deepEqual([...results].sort(), ["ok", "unavailable"]);
    assert.equal(await w.prisma.stagedAsset.count({ where: { path: w.path("adopt") } }), 1);
  } finally {
    await cleanup(w);
  }
});

test("deleting a course releases every lesson video; client cleanup only claims unattached uploads", { skip: skipReason }, async () => {
  const { deleteCourseReleasingVideos } = await import("../src/lib/lesson-video-lifecycle");
  const { requestStagedCleanup, attachLessonVideo } = await import("../src/lib/staged-assets");
  const w = await world();
  try {
    // Course delete.
    await Promise.all([w.stage("c1"), w.stage("c2")]);
    const l1 = await w.lesson({ videoStorageBucket: BUCKET, videoStoragePath: w.path("c1") });
    const l2 = await w.lesson({ videoStorageBucket: BUCKET, videoStoragePath: w.path("c2") });
    await w.prisma.$transaction(async (tx) => {
      await attachLessonVideo(tx, { object: w.ref("c1"), lessonId: l1.id, courseId: w.course.id, ownerUserId: w.user.id });
      await attachLessonVideo(tx, { object: w.ref("c2"), lessonId: l2.id, courseId: w.course.id, ownerUserId: w.user.id });
    });
    const ids = await deleteCourseReleasingVideos(w.prisma, { courseId: w.course.id, experienceSlug: w.slug, ownerUserId: w.user.id });
    assert.equal(ids.length, 2);
    assert.equal(await w.prisma.lesson.count({ where: { courseId: w.course.id } }), 0);
    assert.equal((await w.rowOf("c1"))!.status, "CLEANUP_CLAIMED");
    assert.equal((await w.rowOf("c2"))!.status, "CLEANUP_CLAIMED", "rows survive the cascade so the sweeper can finish");

    // Client cleanup (a fresh course so the previous one's rows do not interfere).
    const course2 = await w.prisma.course.create({ data: { experienceId: w.experience.id, title: "Second" } });
    const path2 = (n: string) => `experiences/${w.slug}/courses/${course2.id}/lessons/${n}.mp4`;
    await w.prisma.stagedAsset.createMany({ data: ["free", "held"].map((n) => ({ bucket: BUCKET, path: path2(n), ownerUserId: w.user.id, courseId: course2.id })) });
    const heldLesson = await w.prisma.lesson.create({ data: { courseId: course2.id, title: "L", videoSource: "UPLOAD", videoStorageBucket: BUCKET, videoStoragePath: path2("held") } });
    await w.prisma.$transaction((tx) => attachLessonVideo(tx, { object: { bucket: BUCKET, path: path2("held") }, lessonId: heldLesson.id, courseId: course2.id, ownerUserId: w.user.id }));

    const free = await requestStagedCleanup(w.prisma, { object: { bucket: BUCKET, path: path2("free") }, ownerUserId: w.user.id });
    assert.equal(free.ok, true);
    assert.equal((await w.prisma.stagedAsset.findUniqueOrThrow({ where: { bucket_path: { bucket: BUCKET, path: path2("free") } } })).status, "CLEANUP_CLAIMED");
    assert.deepEqual(await requestStagedCleanup(w.prisma, { object: { bucket: BUCKET, path: path2("held") }, ownerUserId: w.user.id }), { ok: false, reason: "IN_USE" });
    assert.equal((await w.prisma.stagedAsset.findUniqueOrThrow({ where: { bucket_path: { bucket: BUCKET, path: path2("held") } } })).status, "ATTACHED");
    // Another user cannot claim someone else's staged upload.
    await w.prisma.stagedAsset.create({ data: { bucket: BUCKET, path: path2("theirs"), ownerUserId: w.user.id, courseId: course2.id } });
    assert.deepEqual(await requestStagedCleanup(w.prisma, { object: { bucket: BUCKET, path: path2("theirs") }, ownerUserId: "someone-else" }), { ok: false, reason: "IN_USE" });
    // A pre-existing object nobody references can be claimed; one a lesson references cannot.
    assert.equal((await requestStagedCleanup(w.prisma, { object: { bucket: BUCKET, path: path2("orphan") }, ownerUserId: w.user.id })).ok, true);
    await w.prisma.lesson.create({ data: { courseId: course2.id, title: "L2", videoSource: "UPLOAD", videoStorageBucket: BUCKET, videoStoragePath: path2("inuse") } });
    assert.deepEqual(await requestStagedCleanup(w.prisma, { object: { bucket: BUCKET, path: path2("inuse") }, ownerUserId: w.user.id }), { ok: false, reason: "IN_USE" });
  } finally {
    await cleanup(w);
  }
});

test("an administrator's cleanup request claims only unattached, unreferenced uploads", { skip: skipReason }, async () => {
  const { requestStagedCleanup, attachLessonVideo } = await import("../src/lib/staged-assets");
  const w = await world();
  try {
    // Another creator's attached video and a lesson-referenced (row-less) video are refused.
    await w.stage("attached");
    const lesson = await w.lesson({ videoStorageBucket: BUCKET, videoStoragePath: w.path("attached") });
    await w.prisma.$transaction((tx) => attachLessonVideo(tx, { object: w.ref("attached"), lessonId: lesson.id, courseId: w.course.id, ownerUserId: w.user.id }));
    await w.lesson({ videoStorageBucket: BUCKET, videoStoragePath: w.path("legacy") });
    const asAdmin = { ownerUserId: "an-admin", anyOwner: true };
    assert.deepEqual(await requestStagedCleanup(w.prisma, { object: w.ref("attached"), ...asAdmin }), { ok: false, reason: "IN_USE" });
    assert.deepEqual(await requestStagedCleanup(w.prisma, { object: w.ref("legacy"), ...asAdmin }), { ok: false, reason: "IN_USE" });
    assert.equal((await w.rowOf("attached"))!.status, "ATTACHED", "the attached object is untouched");

    // An abandoned upload from another creator can be claimed; it is then never attachable.
    await w.stage("abandoned");
    const claimed = await requestStagedCleanup(w.prisma, { object: w.ref("abandoned"), ...asAdmin });
    assert.equal(claimed.ok, true);
    assert.equal((await w.rowOf("abandoned"))!.status, "CLEANUP_CLAIMED");
    // A non-admin who does not own the upload is still refused.
    await w.stage("theirs");
    assert.deepEqual(await requestStagedCleanup(w.prisma, { object: w.ref("theirs"), ownerUserId: "someone-else" }), { ok: false, reason: "IN_USE" });
  } finally {
    await cleanup(w);
  }
});

test("issuing an upload stages it once and a repeat is a no-op", { skip: skipReason }, async () => {
  const { stageUpload } = await import("../src/lib/staged-assets");
  const w = await world();
  try {
    await stageUpload(w.prisma, { ...w.ref("fresh"), ownerUserId: w.user.id, courseId: w.course.id });
    await stageUpload(w.prisma, { ...w.ref("fresh"), ownerUserId: w.user.id, courseId: w.course.id });
    const row = (await w.rowOf("fresh"))!;
    assert.equal(row.status, "STAGED");
    assert.equal(await w.prisma.stagedAsset.count({ where: { path: w.path("fresh") } }), 1);
  } finally {
    await cleanup(w);
  }
});
