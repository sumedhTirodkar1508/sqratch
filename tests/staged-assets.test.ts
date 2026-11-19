import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { createLessonVideoUploadHandler } from "../src/lib/lesson-video-upload-handler";

const creator = { userId: "creator-user", creatorProfile: { id: "p", userId: "creator-user", displayName: "C" } };
const request = () =>
  new NextRequest("http://localhost/api/uploads/video", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ courseId: "course-1", fileName: "lesson.mp4", fileType: "video/mp4", fileSize: 1024 * 1024 }),
  });

test("an issued upload is staged for its owner and course before the signed URL is returned", async () => {
  const order: string[] = [];
  const staged: unknown[] = [];
  const handler = createLessonVideoUploadHandler({
    getCreator: async () => creator,
    findOwnedCourse: async () => ({ id: "course-1", experience: { slug: "exp" } }),
    signUpload: async (input) => (order.push("sign"), { bucket: input.bucket, path: input.path, signedUrl: "https://upload.example/x" }),
    stageUpload: async (input) => (order.push("stage"), void staged.push(input)),
  });
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.deepEqual(order, ["sign", "stage"]);
  const body = (await response.json()).data;
  assert.deepEqual(staged, [{ bucket: body.bucket, path: body.path, ownerUserId: "creator-user", courseId: "course-1" }]);
});

test("if staging fails no signed URL is returned", async () => {
  const handler = createLessonVideoUploadHandler({
    getCreator: async () => creator,
    findOwnedCourse: async () => ({ id: "course-1", experience: { slug: "exp" } }),
    signUpload: async (input) => ({ bucket: input.bucket, path: input.path, signedUrl: "https://upload.example/x" }),
    stageUpload: async () => { throw new Error("db down"); },
  });
  const response = await handler(request());
  assert.equal(response.status, 500);
  assert.doesNotMatch(JSON.stringify(await response.json()), /upload\.example/);
});

test("the sweeper endpoint requires the cron secret and is not scheduled by the repository", async () => {
  process.env.CRON_SECRET = "test-secret-value";
  const { POST } = await import("../src/app/api/internal/asset-sweeper/route");
  const denied = await POST(new Request("http://localhost/api/internal/asset-sweeper", { method: "POST" }));
  assert.equal(denied.status, 401);
  const wrong = await POST(new Request("http://localhost/api/internal/asset-sweeper", { method: "POST", headers: { "x-cron-secret": "nope" } }));
  assert.equal(wrong.status, 401);
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync("vercel.json"), false, "nothing schedules the sweeper automatically");
});
