/* eslint-disable @typescript-eslint/no-explicit-any -- loose Prisma-shaped fixtures */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NextRequest, NextResponse } from "next/server";
import { publicDisplayName } from "../src/lib/display-name";

type Handler = (request: NextRequest, context: { params: Promise<{ id: string }> }) => Promise<Response>;

const ROUTE = "src/app/api/brand/campaigns/[id]/attach-experience/route.ts";
const PAGE = "src/app/(withSidebar)/dashboard/brand/campaigns/[id]/experiences/page.tsx";

function exp(i: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `e${String(i).padStart(3, "0")}`,
    title: `Experience ${i}`,
    slug: `experience-${i}`,
    description: null,
    isActive: true,
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
    creator: { displayName: i % 2 ? `Creator ${i}` : null, user: { name: i % 2 ? null : `User ${i}`, email: "secret@example.test" } },
    ...overrides,
  };
}

function load(db: object, brandId: string | null = "brand-1") {
  const exports: Record<string, Handler> = {};
  const modules: Record<string, unknown> = {
    "next/server": { NextRequest, NextResponse },
    "@/lib/display-name": { publicDisplayName },
    "@/lib/brand-auth": {
      getBrandAdminContext: async () => (brandId ? { membership: { brand: { id: brandId, name: "Brand" } } } : null),
      getBrandContextFailure: () => ({ error: "Brand admin access required.", status: 403 }),
      assertExpectedBrand: () => null,
      getOwnedBrandCampaign: async (id: string, ownerBrandId: string) =>
        id === "camp-1" && ownerBrandId === "brand-1" ? { id, name: "Campaign", slug: "c", description: null, isActive: true, brandId: ownerBrandId } : null,
    },
    "@/lib/prisma": { __esModule: true, default: db },
  };
  const source = ts.transpileModule(readFileSync(ROUTE, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  runInNewContext(source, { exports, require: (id: string) => { if (!(id in modules)) throw new Error(`Unexpected dependency ${id}`); return modules[id]; }, console, Date, Buffer, Number, JSON, Set, Math, Array, String, Boolean, Error }, {});
  return exports;
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (qs = "") => new NextRequest(`https://example.test/api/brand/campaigns/camp-1/attach-experience${qs}`);

function fakeDb(opts: { attached: number; discover: number; draftEvery?: number }) {
  const calls: { experienceFindMany: any[]; attachedFindMany: any[] } = { experienceFindMany: [], attachedFindMany: [] };
  const attachedRows = Array.from({ length: opts.attached }, (_, i) => ({
    experienceId: `a${i}`,
    sortOrder: i,
    experience: exp(i, { id: `a${i}`, title: `Attached ${i}`, isActive: opts.draftEvery ? i % opts.draftEvery !== 0 : true }),
  }));
  const discoverPool = Array.from({ length: opts.discover }, (_, i) => exp(1000 - i));
  const db = {
    campaignExperience: { findMany: async (args: any) => { calls.attachedFindMany.push(args); return attachedRows; } },
    experience: {
      findMany: async (args: any) => {
        calls.experienceFindMany.push(args);
        // First call per request is discovery (has `take: limit + 1`); the
        // legacy call is `take: 50` with an `OR` on attached ids.
        return args.take === 50 ? discoverPool.slice(0, 50) : discoverPool.slice(0, args.take);
      },
    },
  };
  return { db, calls };
}

test("GET returns every attached row (60) with status and creator name, never creator email", async () => {
  const { db, calls } = fakeDb({ attached: 60, discover: 100, draftEvery: 10 });
  const response = await load(db).GET(get(), ctx("camp-1"));
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.attached.length, 60);
  assert.equal(data.attached.filter((e: any) => e.status === "DRAFT").length, 6);
  assert.equal(data.attached[0].creatorName, publicDisplayName({ name: "User 0" }));
  assert.equal(data.attached[1].creatorName, "Creator 1");
  assert.equal(calls.attachedFindMany[0].where.campaignId, "camp-1");
  assert.equal(calls.attachedFindMany[0].take, undefined, "the attached list must never be limited");
  assert.doesNotMatch(JSON.stringify(data), /secret@example\.test|"email"/);
  assert.ok(Array.isArray(data.experiences), "legacy experiences array is kept (additive)");
});

test("discovery is published-only, excludes this campaign's attachments, and pages by cursor", async () => {
  const { db, calls } = fakeDb({ attached: 3, discover: 120 });
  const route = load(db);
  const first = (await (await route.GET(get("?limit=50&q=exp"), ctx("camp-1"))).json()).data;
  const discoverQuery = calls.experienceFindMany.find((a) => a.take === 51);
  assert.ok(discoverQuery, "discovery asks for limit + 1 rows");
  const where = JSON.stringify(discoverQuery.where);
  assert.match(where, /"isActive":true/);
  assert.match(where, /"campaigns":\{"none":\{"campaignId":"camp-1"\}\}/);
  assert.match(where, /"contains":"exp"/);
  assert.equal(first.discover.items.length, 50);
  assert.equal(first.discover.meta.hasNextPage, true);
  assert.ok(first.discover.meta.nextCursor);

  const second = await route.GET(get(`?limit=50&cursor=${first.discover.meta.nextCursor}`), ctx("camp-1"));
  assert.equal(second.status, 200);
  const cursorQuery = calls.experienceFindMany.filter((a) => a.take === 51)[1];
  assert.match(JSON.stringify(cursorQuery.where), /"updatedAt":\{"lt":/);
});

test("last discovery page has no next cursor, bad cursors are rejected, limit is capped", async () => {
  const short = fakeDb({ attached: 0, discover: 7 });
  const done = (await (await load(short.db).GET(get(), ctx("camp-1"))).json()).data;
  assert.equal(done.discover.items.length, 7);
  assert.deepEqual({ ...done.discover.meta }, { hasNextPage: false, nextCursor: null, limit: 24 });

  const bad = await load(short.db).GET(get("?cursor=not-a-cursor"), ctx("camp-1"));
  assert.equal(bad.status, 400);

  const capped = fakeDb({ attached: 0, discover: 500 });
  const body = (await (await load(capped.db).GET(get("?limit=9999"), ctx("camp-1"))).json()).data;
  assert.equal(body.discover.meta.limit, 50);
  assert.equal(body.discover.items.length, 50);
});

test("brand isolation: a campaign owned by another brand returns 404 and reads no experiences", async () => {
  const { db, calls } = fakeDb({ attached: 5, discover: 5 });
  const response = await load(db, "brand-2").GET(get(), ctx("camp-1"));
  assert.equal(response.status, 404);
  assert.equal(calls.attachedFindMany.length + calls.experienceFindMany.length, 0);
  const anonymous = await load(db, null).GET(get(), ctx("camp-1"));
  assert.equal(anonymous.status, 403);
});

test("attachment stays immediate and still rejects drafts", async () => {
  let upserts = 0;
  const db = {
    experience: { findUnique: async ({ where }: any) => (where.id === "draft" ? { id: "draft", isActive: false } : { id: where.id, isActive: true }) },
    campaignExperience: { upsert: async () => { upserts++; return {}; }, deleteMany: async () => ({ count: 1 }) },
  };
  const post = (body: object) => new NextRequest("https://example.test/x", { method: "POST", body: JSON.stringify(body) });
  const route = load(db);
  assert.equal((await route.POST(post({ experienceId: "draft", attach: true }), ctx("camp-1"))).status, 400);
  assert.equal(upserts, 0);
  assert.equal((await route.POST(post({ experienceId: "live", attach: true }), ctx("camp-1"))).status, 200);
  assert.equal(upserts, 1);
  assert.equal((await route.POST(post({ experienceId: "draft", attach: false }), ctx("camp-1"))).status, 200);
});

test("the page renders attached rows fully, flags drafts, shows creators and loads more discovery", () => {
  const page = readFileSync(PAGE, "utf8");
  assert.match(page, /data\.attached\.map/);
  assert.match(page, /Hidden until republished/);
  assert.match(page, /experience\.creatorName/);
  assert.match(page, /Load more/);
  assert.match(page, /qs\.set\("cursor"/);
  assert.doesNotMatch(page, /data\.experiences/);
});
