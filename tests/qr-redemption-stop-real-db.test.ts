import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { realDbTest } from "./helpers/real-db";
import type { AuthResolvers } from "../src/lib/auth-session";

const { skipReason } = realDbTest("QR_STOP_REAL_DB");

const sessionId = () => randomBytes(24).toString("hex");

async function world(codeCount = 3) {
  const { default: prisma } = await import("../src/lib/prisma");
  const key = randomUUID();
  const admin = await prisma.user.create({ data: { email: `${key}-admin@example.test`, role: "BRAND_ADMIN" } });
  const learner = await prisma.user.create({ data: { email: `${key}-learner@example.test` } });
  const brand = await prisma.brand.create({ data: { name: key, slug: key } });
  const otherBrand = await prisma.brand.create({ data: { name: `${key}-o`, slug: `${key}-o` } });
  const campaign = await prisma.campaign.create({ data: { name: key, slug: key, brandId: brand.id, createdById: admin.id } });
  const batch = await prisma.qRCodeBatch.create({ data: { name: `${key}-batch`, campaignId: campaign.id } });
  const codes = await Promise.all(
    Array.from({ length: codeCount }, (_, i) =>
      prisma.qRCode.create({ data: { qrCodeData: `${key}-c${i}`, campaignId: campaign.id, createdById: admin.id, batchId: batch.id } }),
    ),
  );
  const brandDeps = (brandId: string) =>
    ({
      resolveSession: async () => ({ user: { id: admin.id, role: "BRAND_ADMIN" } }),
      resolveBrandAdminContext: async () => ({ userId: admin.id, selectionRequired: false, brands: [], membership: { id: "m", role: "ADMIN", brand: { id: brandId, name: "B", slug: "b" } } }),
    }) as unknown as AuthResolvers;
  const viewerDeps = (userId: string | null) =>
    ({ resolveSession: async () => (userId ? { user: { id: userId, email: `${userId}@example.test` } } : null), resolveBrandAdminContext: async () => null }) as unknown as AuthResolvers;
  return { prisma, key, admin, learner, brand, otherBrand, campaign, batch, codes, brandDeps, viewerDeps, extraUsers: [] as string[] };
}

async function cleanup(w: Awaited<ReturnType<typeof world>>) {
  const { prisma } = w;
  const users = [w.admin.id, w.learner.id, ...w.extraUsers];
  await prisma.pointTransaction.deleteMany({ where: { userId: { in: users } } });
  await prisma.analyticsEvent.deleteMany({ where: { campaignId: w.campaign.id } });
  await prisma.campaignUnlock.deleteMany({ where: { campaignId: w.campaign.id } });
  await prisma.userSession.deleteMany({ where: { campaignId: w.campaign.id } });
  await prisma.qRCode.deleteMany({ where: { campaignId: w.campaign.id } });
  await prisma.qRCodeBatch.deleteMany({ where: { campaignId: w.campaign.id } });
  await prisma.campaign.deleteMany({ where: { id: w.campaign.id } });
  await prisma.brand.deleteMany({ where: { id: { in: [w.brand.id, w.otherBrand.id] } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
}

const post = (url = "http://localhost/x") => new NextRequest(url, { method: "POST" });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const scan = async (w: Awaited<ReturnType<typeof world>>, data: string, userId: string | null, session?: string) => {
  const { scanImpl } = await import("../src/app/api/public/scan/route");
  // A distinct address per call so the per-IP scan limiter never interferes.
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (session) headers.cookie = `sqr_session=${session}`;
  return scanImpl(new NextRequest("http://localhost/api/public/scan", { method: "POST", headers, body: JSON.stringify({ qrCodeData: data }) }), w.viewerDeps(userId));
};

test("stopping a batch only affects NEW codes, is brand scoped and idempotent; resume spares individually stopped codes", { skip: skipReason }, async () => {
  const { stopBatchRedemptionsImpl } = await import("../src/app/api/brand/qr-batches/[id]/stop-redemptions/route");
  const { resumeBatchRedemptionsImpl } = await import("../src/app/api/brand/qr-batches/[id]/resume-redemptions/route");
  const { stopCodeRedemptionImpl } = await import("../src/app/api/brand/qr-codes/[id]/stop-redemption/route");
  const { resumeCodeRedemptionImpl } = await import("../src/app/api/brand/qr-codes/[id]/resume-redemption/route");
  const w = await world(4);
  const deps = w.brandDeps(w.brand.id);
  const state = async () => Object.fromEntries((await w.prisma.qRCode.findMany({ where: { campaignId: w.campaign.id } })).map((c) => [c.qrCodeData, c]));
  try {
    const [c0, c1, c2, c3] = w.codes;
    // c0 is redeemed already; c1 is stopped on its own first.
    await w.prisma.qRCode.update({ where: { id: c0.id }, data: { status: "USED", redeemedById: w.learner.id, usedAt: new Date() } });
    assert.equal((await stopCodeRedemptionImpl(post(), ctx(c1.id), deps)).status, 200);
    const own = (await state())[c1.qrCodeData].redemptionStoppedAt;
    assert.ok(own);

    // Another brand cannot touch this batch or these codes.
    const foreign = w.brandDeps(w.otherBrand.id);
    assert.equal((await stopBatchRedemptionsImpl(post(), ctx(w.batch.id), foreign)).status, 404);
    assert.equal((await stopCodeRedemptionImpl(post(), ctx(c2.id), foreign)).status, 404);
    assert.equal((await state())[c2.qrCodeData].redemptionStoppedAt, null);

    // A redeemed code cannot be stopped.
    const used = await stopCodeRedemptionImpl(post(), ctx(c0.id), deps);
    assert.equal(used.status, 409);
    assert.equal((await used.json()).code, "QR_ALREADY_USED");

    // Batch stop: NEW codes stopped, USED untouched, c1 keeps its own timestamp.
    const stop = await stopBatchRedemptionsImpl(post(), ctx(w.batch.id), deps);
    assert.equal(stop.status, 200);
    assert.equal((await stop.json()).data.codesAffected, 2);
    let s = await state();
    assert.equal(s[c0.qrCodeData].redemptionStoppedAt, null, "USED code untouched");
    assert.equal(s[c1.qrCodeData].redemptionStoppedAt?.getTime(), own!.getTime(), "own timestamp kept");
    assert.ok(s[c2.qrCodeData].redemptionStoppedAt && s[c3.qrCodeData].redemptionStoppedAt);
    const batch = await w.prisma.qRCodeBatch.findUniqueOrThrow({ where: { id: w.batch.id } });
    assert.ok(batch.redemptionStoppedAt);
    assert.equal(batch.redemptionStoppedById, w.admin.id);
    assert.equal(batch.archivedAt, null, "stopping is not archiving");

    // Repeating is a no-op that does not re-stop an individually resumed code.
    assert.equal((await resumeCodeRedemptionImpl(post(), ctx(c3.id), deps)).status, 200);
    const again = await stopBatchRedemptionsImpl(post(), ctx(w.batch.id), deps);
    assert.equal((await again.json()).data.codesAffected, 0);
    assert.equal((await state())[c3.qrCodeData].redemptionStoppedAt, null);

    // Stopping a code that the batch already stopped gives it its own stamp: the batch resume must not undo it.
    assert.equal((await stopCodeRedemptionImpl(post(), ctx(c2.id), deps)).status, 200);
    assert.notEqual((await state())[c2.qrCodeData].redemptionStoppedAt?.getTime(), (await w.prisma.qRCodeBatch.findUniqueOrThrow({ where: { id: w.batch.id } })).redemptionStoppedAt?.getTime());

    // Batch resume clears only what the batch stopped; c1 stays stopped.
    const resume = await resumeBatchRedemptionsImpl(post(), ctx(w.batch.id), deps);
    assert.equal(resume.status, 200);
    s = await state();
    assert.equal(s[c1.qrCodeData].redemptionStoppedAt?.getTime(), own!.getTime(), "individually stopped code stays stopped");
    assert.ok(s[c2.qrCodeData].redemptionStoppedAt, "a code stopped on its own inside a stopped batch stays stopped");
    assert.equal((await w.prisma.qRCodeBatch.findUniqueOrThrow({ where: { id: w.batch.id } })).redemptionStoppedAt, null);
    assert.equal((await stopBatchRedemptionsImpl(new NextRequest("http://localhost/x", { method: "POST", headers: { "x-sqratch-expected-brand": "someone-else" } }), ctx(w.batch.id), deps)).status, 409);
  } finally {
    await cleanup(w);
  }
});

test("a stopped code creates no unlock, point or status change; people who already unlocked still get through", { skip: skipReason }, async () => {
  const { stopBatchRedemptionsImpl } = await import("../src/app/api/brand/qr-batches/[id]/stop-redemptions/route");
  const { resumeBatchRedemptionsImpl } = await import("../src/app/api/brand/qr-batches/[id]/resume-redemptions/route");
  const w = await world(4);
  const deps = w.brandDeps(w.brand.id);
  const [early, stopped, anon, resumed] = w.codes;
  const anonSession = sessionId();
  try {
    // Before the stop: the learner unlocks via `early`; an anonymous session unlocks via `anon`.
    assert.equal((await scan(w, early.qrCodeData, w.learner.id)).status, 200);
    assert.equal((await scan(w, anon.qrCodeData, null, anonSession)).status, 200);
    assert.equal(await w.prisma.campaignUnlock.count({ where: { campaignId: w.campaign.id } }), 2);

    assert.equal((await stopBatchRedemptionsImpl(post(), ctx(w.batch.id), deps)).status, 200);
    const ledgerBefore = await w.prisma.pointTransaction.count({ where: { userId: w.learner.id } });

    // New visitors are refused with the stopped code and nothing is written.
    const stranger = await w.prisma.user.create({ data: { email: `${w.key}-s@example.test` } });
    w.extraUsers.push(stranger.id);
    const signedIn = await scan(w, stopped.qrCodeData, stranger.id);
    assert.equal(signedIn.status, 409);
    const body = await signedIn.json();
    assert.equal(body.code, "QR_REDEMPTION_STOPPED");
    assert.equal(body.campaignSlug, w.campaign.slug);
    assert.equal((await scan(w, stopped.qrCodeData, null, sessionId())).status, 409, "anonymous visitor");
    assert.equal((await scan(w, stopped.qrCodeData, null)).status, 409, "no session at all");
    assert.equal(await w.prisma.campaignUnlock.count({ where: { campaignId: w.campaign.id } }), 2, "no new unlock");
    assert.equal(await w.prisma.pointTransaction.count({ where: { userId: stranger.id } }), 0);
    const row = await w.prisma.qRCode.findUniqueOrThrow({ where: { id: stopped.id } });
    assert.equal(row.status, "NEW");
    assert.equal(row.redeemedById, null);
    assert.ok(await w.prisma.analyticsEvent.count({ where: { qrCodeId: stopped.id, name: "qr_scan_stopped" } }));

    // A refused scan does not re-point the visitor's session at the stopped code.
    const strangerSession = sessionId();
    assert.equal((await scan(w, stopped.qrCodeData, null, strangerSession)).status, 409);
    assert.equal(await w.prisma.userSession.count({ where: { id: strangerSession } }), 0, "no session attribution written for a stopped code");

    // Someone who already holds an unlock for the campaign is sent on without a second redemption.
    assert.equal((await scan(w, stopped.qrCodeData, w.learner.id)).status, 200);
    assert.equal((await scan(w, stopped.qrCodeData, null, anonSession)).status, 200);
    assert.equal((await w.prisma.qRCode.findUniqueOrThrow({ where: { id: stopped.id } })).status, "NEW");
    assert.equal(await w.prisma.pointTransaction.count({ where: { userId: w.learner.id } }), ledgerBefore);
    assert.equal(await w.prisma.campaignUnlock.count({ where: { campaignId: w.campaign.id } }), 2);

    // A signed-in viewer whose anonymous unlock has not moved to the account yet is not told to "sign in".
    const pending = await w.prisma.user.create({ data: { email: `${w.key}-p@example.test` } });
    w.extraUsers.push(pending.id);
    assert.equal((await scan(w, stopped.qrCodeData, pending.id, anonSession)).status, 200);

    // Resuming makes the very same code redeemable again.
    assert.equal((await resumeBatchRedemptionsImpl(post(), ctx(w.batch.id), deps)).status, 200);
    assert.equal((await scan(w, resumed.qrCodeData, stranger.id)).status, 200);
    assert.equal((await w.prisma.qRCode.findUniqueOrThrow({ where: { id: resumed.id } })).status, "USED");
    assert.equal(await w.prisma.pointTransaction.count({ where: { userId: stranger.id } }), 1);
  } finally {
    await cleanup(w);
  }
});

test("an anonymous unlock that already exists converts on sign-in even after the code is stopped", { skip: skipReason }, async () => {
  const { stopBatchRedemptionsImpl } = await import("../src/app/api/brand/qr-batches/[id]/stop-redemptions/route");
  const { transferAnonymousState } = await import("../src/lib/anonymous-transfer");
  const { redeemQrCodeForUser } = await import("../src/lib/qr-redemption");
  const w = await world(2);
  const [code, other] = w.codes;
  const session = sessionId();
  try {
    assert.equal((await scan(w, code.qrCodeData, null, session)).status, 200);
    const unlock = await w.prisma.campaignUnlock.findFirstOrThrow({ where: { anonKey: session } });
    assert.equal(unlock.qrCodeId, code.id);

    assert.equal((await stopBatchRedemptionsImpl(post(), ctx(w.batch.id), w.brandDeps(w.brand.id))).status, 200);
    assert.ok((await w.prisma.qRCode.findUniqueOrThrow({ where: { id: code.id } })).redemptionStoppedAt);

    // The helper itself refuses a stopped code unless it is honouring an existing unlock.
    const refused = await redeemQrCodeForUser({ qrCodeId: other.id, userId: w.learner.id });
    assert.equal(refused.redeemed, false);
    assert.equal(refused.stopped, true);
    assert.equal((await w.prisma.qRCode.findUniqueOrThrow({ where: { id: other.id } })).status, "NEW");

    const result = await transferAnonymousState({ userId: w.learner.id, userEmail: w.learner.email, sessionId: session });
    assert.equal(result.status, "complete");
    assert.equal(result.mergedUnlocks, 1);
    const moved = await w.prisma.campaignUnlock.findUniqueOrThrow({ where: { id: unlock.id } });
    assert.equal(moved.userId, w.learner.id, "the earned unlock was not destroyed");
    const redeemed = await w.prisma.qRCode.findUniqueOrThrow({ where: { id: code.id } });
    assert.equal(redeemed.status, "USED");
    assert.equal(redeemed.redeemedById, w.learner.id);
    assert.equal(await w.prisma.pointTransaction.count({ where: { userId: w.learner.id, qrCodeId: code.id } }), 1);
    // The redeemed code still carries its stop stamp; a later scan treats it as redeemed (200), never as stopped.
    assert.equal((await scan(w, code.qrCodeData, null, sessionId())).status, 200);
  } finally {
    await cleanup(w);
  }
});

test("fifty concurrent redemptions against a concurrent stop end in one consistent state per code", { skip: skipReason }, async () => {
  const { stopBatchRedemptionsImpl } = await import("../src/app/api/brand/qr-batches/[id]/stop-redemptions/route");
  const w = await world(50);
  try {
    const learners = await Promise.all(
      w.codes.map((_, i) => w.prisma.user.create({ data: { email: `${w.key}-l${i}@example.test` } })),
    );
    w.extraUsers.push(...learners.map((u) => u.id));
    const anonSessions = w.codes.map(() => sessionId());
    const deps = w.brandDeps(w.brand.id);

    const outcomes = await Promise.all([
      ...w.codes.map((c, i) => scan(w, c.qrCodeData, learners[i].id).then((r) => ({ kind: "signed" as const, i, status: r.status }))),
      stopBatchRedemptionsImpl(post(), ctx(w.batch.id), deps).then((r) => ({ kind: "stop" as const, i: -1, status: r.status })),
    ]);
    assert.equal(outcomes.find((o) => o.kind === "stop")!.status, 200);

    const rows = await w.prisma.qRCode.findMany({ where: { campaignId: w.campaign.id } });
    let usedCount = 0;
    let stoppedCount = 0;
    for (const [i, code] of w.codes.entries()) {
      const row = rows.find((r) => r.id === code.id)!;
      const unlocks = await w.prisma.campaignUnlock.count({ where: { qrCodeId: code.id, userId: learners[i].id } });
      const ledger = await w.prisma.pointTransaction.count({ where: { qrCodeId: code.id, userId: learners[i].id } });
      const status = outcomes.find((o) => o.kind === "signed" && o.i === i)!.status;
      if (row.status === "USED") {
        usedCount += 1;
        assert.equal(row.redeemedById, learners[i].id);
        assert.equal(status, 200);
        assert.equal(unlocks, 1, "USED code has an unlock");
        assert.equal(ledger, 1, "USED code has a ledger row");
      } else {
        stoppedCount += 1;
        assert.ok(row.redemptionStoppedAt, "an unredeemed code is stopped, never merely NEW");
        assert.equal(status, 409);
        assert.equal(unlocks + ledger, 0, "a stopped code left no unlock or ledger row");
      }
    }
    assert.equal(usedCount + stoppedCount, 50);

    // Anonymous scans racing a second batch stop: each either created an unlock or got 409, never both.
    const w2codes = await Promise.all(
      Array.from({ length: 20 }, (_, i) => w.prisma.qRCode.create({ data: { qrCodeData: `${w.key}-b${i}`, campaignId: w.campaign.id, createdById: w.admin.id } })),
    );
    const batch2 = await w.prisma.qRCodeBatch.create({ data: { name: `${w.key}-2`, campaignId: w.campaign.id } });
    await w.prisma.qRCode.updateMany({ where: { id: { in: w2codes.map((c) => c.id) } }, data: { batchId: batch2.id } });
    const anon = await Promise.all([
      ...w2codes.map((c, i) => scan(w, c.qrCodeData, null, anonSessions[i]).then((r) => ({ i, status: r.status }))),
      stopBatchRedemptionsImpl(post(), ctx(batch2.id), deps),
    ]);
    for (const [i, code] of w2codes.entries()) {
      const unlocks = await w.prisma.campaignUnlock.count({ where: { qrCodeId: code.id, anonKey: anonSessions[i] } });
      const status = (anon[i] as { status: number }).status;
      assert.equal(unlocks, status === 200 ? 1 : 0, `anonymous scan ${i}: status ${status}, unlocks ${unlocks}`);
      assert.ok([200, 409].includes(status));
    }
  } finally {
    await cleanup(w);
  }
});

test("two concurrent anonymous scans of one code from one session both succeed", { skip: skipReason }, async () => {
  const w = await world(1);
  const session = sessionId();
  try {
    const [a, b] = await Promise.all([scan(w, w.codes[0].qrCodeData, null, session), scan(w, w.codes[0].qrCodeData, null, session)]);
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.equal(await w.prisma.campaignUnlock.count({ where: { anonKey: session } }), 1);
  } finally {
    await cleanup(w);
  }
});

test("the NEW inventory filter excludes INVALID codes and the list labels them", { skip: skipReason }, async () => {
  const { listQrBatchesImpl } = await import("../src/app/api/brand/qr-batches/route");
  const w = await world(3);
  try {
    await w.prisma.qRCode.update({ where: { id: w.codes[0].id }, data: { status: "INVALID" } });
    await w.prisma.qRCode.update({ where: { id: w.codes[1].id }, data: { status: "USED", redeemedById: w.learner.id, usedAt: new Date() } });
    const list = async (query: string) => {
      const response = await listQrBatchesImpl(new NextRequest(`http://localhost/api/brand/qr-batches${query}`), w.brandDeps(w.brand.id));
      assert.equal(response.status, 200);
      return (await response.json()).data.qrCodes as Array<{ id: string; status: string }>;
    };
    assert.deepEqual((await list("?status=NEW")).map((c) => c.id), [w.codes[2].id]);
    const all = await list("");
    assert.equal(all.find((c) => c.id === w.codes[0].id)!.status, "INVALID");
    assert.equal(all.find((c) => c.id === w.codes[1].id)!.status, "REDEEMED");
  } finally {
    await cleanup(w);
  }
});

test("a stopped code is labelled STOPPED in the CSV export and legacy read APIs, never as available", { skip: skipReason }, async () => {
  const { exportBatchImpl } = await import("../src/app/api/brand/qr-batches/[id]/export/route");
  const { getAllQrCodesImpl } = await import("../src/app/api/qr/get-all-qrcodes/route");
  const { checkQrCodeImpl } = await import("../src/app/api/qr/check-qrcode/[qrcodeID]/route");
  const { stopBatchRedemptionsImpl } = await import("../src/app/api/brand/qr-batches/[id]/stop-redemptions/route");
  const { qrDisplayStatus } = await import("../src/lib/qr-display-status");
  const w = await world(4);
  const deps = w.brandDeps(w.brand.id);
  const [live, used, invalid, plain] = w.codes;
  try {
    assert.equal(qrDisplayStatus({ status: "NEW", redemptionStoppedAt: null }), "NEW");
    assert.equal(qrDisplayStatus({ status: "NEW", redemptionStoppedAt: new Date() }), "STOPPED");
    assert.equal(qrDisplayStatus({ status: "USED", redemptionStoppedAt: new Date() }), "REDEEMED", "a redeemed code that carries a stop stamp is redeemed");
    await w.prisma.qRCode.update({ where: { id: used.id }, data: { status: "USED", redeemedById: w.learner.id, usedAt: new Date() } });
    await w.prisma.qRCode.update({ where: { id: invalid.id }, data: { status: "INVALID" } });
    assert.equal((await stopBatchRedemptionsImpl(post(), ctx(w.batch.id), deps)).status, 200);

    const csv = await (await exportBatchImpl(new NextRequest(`http://localhost/api/brand/qr-batches/${w.batch.id}/export`), ctx(w.batch.id), deps)).text();
    const statusOf = (code: string) => csv.split("\n").find((line) => line.includes(code))!.split('","')[2];
    assert.equal(statusOf(live.qrCodeData), "STOPPED");
    assert.equal(statusOf(plain.qrCodeData), "STOPPED");
    assert.equal(statusOf(used.qrCodeData), "REDEEMED");
    assert.equal(statusOf(invalid.qrCodeData), "INVALID");
    // The printed link is unchanged.
    assert.match(csv, new RegExp(`/q/${live.qrCodeData}`));

    const all = await getAllQrCodesImpl(new NextRequest(`http://localhost/api/qr/get-all-qrcodes?campaignId=${w.campaign.id}`), deps);
    assert.equal(all.status, 200);
    const rows = (await all.json()).data as Array<{ code: string; status: string }>;
    assert.equal(rows.find((r) => r.code === live.qrCodeData)!.status, "STOPPED");
    assert.equal(rows.find((r) => r.code === used.qrCodeData)!.status, "REDEEMED");

    const check = async (code: string) => (await checkQrCodeImpl(new NextRequest(`http://localhost/api/qr/check-qrcode/${code}?campaignId=${w.campaign.id}`), { params: Promise.resolve({ qrcodeID: code }) }, deps)).json();
    assert.deepEqual(await check(live.qrCodeData), { status: "NEW", redemptionStopped: true });
    assert.deepEqual(await check(used.qrCodeData), { status: "USED", redemptionStopped: false });
  } finally {
    await cleanup(w);
  }
});
