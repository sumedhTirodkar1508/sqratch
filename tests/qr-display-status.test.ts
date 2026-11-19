import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { qrDisplayStatus } from "../src/lib/qr-display-status";

test("NEW, REDEEMED, INVALID and STOPPED are distinct display states", () => {
  const stamp = new Date();
  assert.equal(qrDisplayStatus({ status: "NEW", redemptionStoppedAt: null }), "NEW");
  assert.equal(qrDisplayStatus({ status: "NEW", redemptionStoppedAt: stamp }), "STOPPED");
  assert.equal(qrDisplayStatus({ status: "USED", redemptionStoppedAt: null }), "REDEEMED");
  assert.equal(qrDisplayStatus({ status: "USED", redemptionStoppedAt: stamp }), "REDEEMED");
  assert.equal(qrDisplayStatus({ status: "INVALID", redemptionStoppedAt: stamp }), "INVALID");
});

test("every place that labels a code uses the shared status, and archiving never enters it", () => {
  for (const file of ["src/app/api/brand/qr-batches/[id]/export/route.ts", "src/app/api/qr/get-all-qrcodes/route.ts"]) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /qrDisplayStatus\(/, file);
    assert.doesNotMatch(source, /archivedAt/, file);
  }
  assert.doesNotMatch(readFileSync("src/lib/qr-display-status.ts", "utf8").replace(/\/\*[\s\S]*?\*\//, ""), /archived/);
  const stats = readFileSync("src/app/api/dashboard-stats/route.ts", "utf8");
  assert.match(stats, /redemptionStoppedAt: \{ not: null \}/, "stopped codes are counted separately from remaining inventory");
  assert.match(stats, /stoppedCount:/);
});
