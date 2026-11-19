/* eslint-disable @typescript-eslint/no-explicit-any -- loose Prisma-shaped fixtures */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NextResponse } from "next/server";

type Row = { status: string; reason: string | null; createdAt: Date; updatedAt: Date; userId: string; internalNote?: string };

function load(session: unknown, rows: { creator: Row[]; brand: Row[] }, calls: Array<{ model: string; args: any }> = []) {
  const exports: { GET?: () => Promise<Response> } = {};
  const finder = (model: "creator" | "brand") => async (args: any) => {
    calls.push({ model, args });
    const match = rows[model]
      .filter((row) => row.userId === args.where.userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (!match) return null;
    // Honour `select` exactly like Prisma: only the selected keys come back.
    return Object.fromEntries(Object.keys(args.select).map((key) => [key, (match as any)[key]]));
  };
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse },
    "next-auth": { getServerSession: async () => session },
    "@/app/api/auth/[...nextauth]/options": { authOptions: {} },
    "@/lib/prisma": { __esModule: true, default: { creatorRequest: { findFirst: finder("creator") }, brandRequest: { findFirst: finder("brand") } } },
  };
  const source = ts.transpileModule(readFileSync("src/app/api/me/application-status/route.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  runInNewContext(source, { exports, require: (id: string) => { if (!(id in modules)) throw new Error(`Unexpected dependency ${id}`); return modules[id]; }, console, Date });
  return exports as { GET: () => Promise<Response> };
}

const d = (iso: string) => new Date(iso);

test("application status requires an authenticated user and reads nothing otherwise", async () => {
  const calls: Array<{ model: string; args: any }> = [];
  const route = load(null, { creator: [], brand: [] }, calls);
  assert.equal((await route.GET()).status, 401);
  assert.equal(calls.length, 0);
});

test("application status returns only the caller's own latest requests", async () => {
  const calls: Array<{ model: string; args: any }> = [];
  const rows = {
    creator: [
      { userId: "me", status: "REJECTED", reason: "old", createdAt: d("2026-01-01"), updatedAt: d("2026-01-02"), internalNote: "SECRET-OLD" },
      { userId: "me", status: "PENDING", reason: JSON.stringify({ shortReason: "applicant payload" }), createdAt: d("2026-02-01"), updatedAt: d("2026-02-01"), internalNote: "SECRET-NOTE" },
      { userId: "other", status: "APPROVED", reason: "other user reason", createdAt: d("2026-03-01"), updatedAt: d("2026-03-02") },
    ],
    brand: [{ userId: "other", status: "REJECTED", reason: "OTHER-BRAND", createdAt: d("2026-03-01"), updatedAt: d("2026-03-02") }],
  };
  const route = load({ user: { id: "me" } }, rows, calls);
  const response = await route.GET();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.creator.status, "PENDING");
  assert.equal(body.data.creator.createdAt, "2026-02-01T00:00:00.000Z");
  assert.equal(body.data.creator.reason, null, "the applicant's own signup payload is not a decision reason");
  assert.equal(body.data.creator.decidedAt, null);
  assert.equal(body.data.brand, null);
  for (const call of calls) assert.equal(call.args.where.userId, "me");
  assert.doesNotMatch(JSON.stringify(body), /SECRET|other user|OTHER-BRAND|userId|reviewedBy|internalNote/);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("a decided request exposes the applicant-facing reason and decision date", async () => {
  const rows = {
    creator: [],
    brand: [
      { userId: "me", status: "REJECTED", reason: "Please add a store URL", createdAt: d("2026-02-01"), updatedAt: d("2026-02-03"), internalNote: "SECRET-NOTE" },
    ],
  };
  const body = await (await load({ user: { id: "me" } }, rows).GET()).json();
  assert.deepEqual(body.data.brand, { status: "REJECTED", createdAt: "2026-02-01T00:00:00.000Z", reason: "Please add a store URL", decidedAt: "2026-02-03T00:00:00.000Z" });
  assert.equal(body.data.creator, null);
  assert.doesNotMatch(JSON.stringify(body), /SECRET/);
});

test("the pending page refreshes, continues on approval and shows reason plus support on rejection", () => {
  const page = readFileSync("src/app/approval-pending/page.tsx", "utf8");
  assert.match(page, /\/api\/me\/application-status/);
  assert.match(page, /Refresh status/);
  assert.match(page, /status === "APPROVED"[\s\S]*Continue to dashboard/);
  assert.match(page, /status === "REJECTED"[\s\S]*application\.reason[\s\S]*mailto:\$\{SUPPORT_EMAIL\}/);
  assert.match(page, /signOut\(\{ callbackUrl: "\/login" \}\)/);
});

test("the layout redirect and gating helper are unchanged by the status endpoint", () => {
  const layout = readFileSync("src/app/(withSidebar)/layout.tsx", "utf8");
  assert.match(layout, /hasPendingApproval\(session\.user\.id\)/);
  assert.match(layout, /redirect\("\/approval-pending"\)/);
  const route = readFileSync("src/app/api/me/application-status/route.ts", "utf8");
  assert.doesNotMatch(route, /internalNote/);
});
