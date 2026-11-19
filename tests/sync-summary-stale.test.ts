import "./env-setup";
import assert from "node:assert/strict";
import test from "node:test";
import { serializeSyncSummary, STALE_RUNNING_AFTER_MS } from "../src/lib/commerce/sync-summary";

const now = new Date("2026-06-01T12:00:00.000Z");
const run = (status: "RUNNING" | "SUCCEEDED" | "FAILED", agoMs: number) => ({
  lastCompletedSyncAt: null,
  lastAttempt: { status, startedAt: new Date(now.getTime() - agoMs), finishedAt: null },
});

test("a RUNNING sync that started long ago is marked stale; a fresh or finished one is not", () => {
  assert.equal(serializeSyncSummary(run("RUNNING", 60_000), now).lastSyncAttempt?.stale, false);
  assert.equal(serializeSyncSummary(run("RUNNING", STALE_RUNNING_AFTER_MS + 1000), now).lastSyncAttempt?.stale, true);
  assert.equal(serializeSyncSummary(run("FAILED", STALE_RUNNING_AFTER_MS * 5), now).lastSyncAttempt?.stale, false);
  assert.equal(serializeSyncSummary(undefined, now).lastSyncAttempt, null);
});
