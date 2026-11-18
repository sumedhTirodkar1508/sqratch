import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NextRequest, NextResponse } from "next/server";
import { realDbTest } from "./helpers/real-db";
import { publicDisplayName } from "../src/lib/display-name";

const { skipReason } = realDbTest("UX_ATTACH_REAL_DB");

test("attach-experience GET: all 60 attached rows plus 130 discoverable rows page exactly once, with search and tie-breaks", { skip: skipReason }, async () => {
  const { default: prisma } = await import("../src/lib/prisma");
  const key = randomUUID().slice(0, 8);
  const owner = await prisma.user.create({ data: { email: `${key}-o@example.test`, name: "Owner Person", role: "CREATOR" } });
  const profile = await prisma.creatorProfile.create({ data: { userId: owner.id, displayName: `Display ${key}` } });
  const brand = await prisma.brand.create({ data: { name: `Brand ${key}`, slug: `brand-${key}` } });
  const campaign = await prisma.campaign.create({ data: { name: `Camp ${key}`, slug: `camp-${key}`, brandId: brand.id, createdById: owner.id } });
  const otherBrand = await prisma.brand.create({ data: { name: `Other ${key}`, slug: `other-${key}` } });
  const otherCampaign = await prisma.campaign.create({ data: { name: `OtherCamp ${key}`, slug: `othercamp-${key}`, brandId: otherBrand.id, createdById: owner.id } });
  const base = Date.UTC(2026, 0, 1);
  const ids: { attached: string[]; discover: string[]; draftAttached: string[]; unpublished: string[] } = { attached: [], discover: [], draftAttached: [], unpublished: [] };
  try {
    // 60 attached (every 7th is a draft); updatedAt is OLDEST so a limit-50 "newest first" query would drop them.
    for (let i = 0; i < 60; i += 1) {
      const draft = i % 7 === 0;
      const row = await prisma.experience.create({ data: { title: `Attached ${key} ${i}`, slug: `att-${key}-${i}`, creatorId: profile.id, isActive: !draft, updatedAt: new Date(base + i * 1000) } });
      await prisma.campaignExperience.create({ data: { campaignId: campaign.id, experienceId: row.id, sortOrder: i } });
      ids.attached.push(row.id);
      if (draft) ids.draftAttached.push(row.id);
    }
    // 130 discoverable; 10 groups share the same updatedAt to exercise the id tie-break.
    for (let i = 0; i < 130; i += 1) {
      const row = await prisma.experience.create({ data: { title: `Disc ${key} ${i}`, slug: `disc-${key}-${i}`, creatorId: profile.id, updatedAt: new Date(base + 1_000_000 + Math.floor(i / 13) * 1000) } });
      ids.discover.push(row.id);
    }
    // Unpublished and attached elsewhere: never discoverable here.
    const draftUnattached = await prisma.experience.create({ data: { title: `Disc ${key} draft`, slug: `disc-${key}-draft`, creatorId: profile.id, isActive: false } });
    ids.unpublished.push(draftUnattached.id);
    const elsewhere = await prisma.experience.create({ data: { title: `Disc ${key} elsewhere`, slug: `disc-${key}-elsewhere`, creatorId: profile.id } });
    await prisma.campaignExperience.create({ data: { campaignId: otherCampaign.id, experienceId: elsewhere.id } });

    const exports: Record<string, (r: NextRequest, c: { params: Promise<{ id: string }> }) => Promise<Response>> = {};
    const modules: Record<string, unknown> = {
      "next/server": { NextRequest, NextResponse },
      "@/lib/display-name": { publicDisplayName },
      "@/lib/brand-auth": {
        getBrandAdminContext: async () => ({ membership: { brand: { id: brand.id, name: brand.name } } }),
        getBrandContextFailure: () => ({ error: "no", status: 403 }),
        assertExpectedBrand: () => null,
        getOwnedBrandCampaign: (id: string, brandId: string) => prisma.campaign.findFirst({ where: { id, brandId }, select: { id: true, name: true, slug: true, description: true, isActive: true, brandId: true } }),
      },
      "@/lib/prisma": { __esModule: true, default: prisma },
    };
    runInNewContext(ts.transpileModule(readFileSync("src/app/api/brand/campaigns/[id]/attach-experience/route.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
      exports, console, Date, Buffer, Number, JSON, Set, Math, Array, String, Boolean, Error,
      require: (id: string) => { if (!(id in modules)) throw new Error(`Unexpected dependency ${id}`); return modules[id]; },
    });
    const call = async (qs: string) => {
      const response = await exports.GET(new NextRequest(`https://example.test/x${qs}`), { params: Promise.resolve({ id: campaign.id }) });
      assert.equal(response.status, 200);
      return (await response.json()).data;
    };

    const first = await call(`?q=${key}&limit=50`);
    // All 60 attached rows, in sortOrder, including drafts, with creator display name.
    assert.deepEqual(first.attached.map((e: { id: string }) => e.id), ids.attached);
    assert.deepEqual(first.attached.filter((e: { status: string }) => e.status === "DRAFT").map((e: { id: string }) => e.id).sort(), [...ids.draftAttached].sort());
    assert.ok(first.attached.every((e: { creatorName: string }) => e.creatorName === `Display ${key}`));
    assert.doesNotMatch(JSON.stringify(first), /@example\.test/);

    // Walk discovery: 130 rows over 3 pages, each exactly once, no attached/drafts/other-campaign leakage... except "elsewhere" which IS discoverable.
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { discover: { items: { id: string }[]; meta: { hasNextPage: boolean; nextCursor: string | null } } } = await call(`?q=${key}&limit=50${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...page.discover.items.map((e) => e.id));
      cursor = page.discover.meta.nextCursor;
      pages += 1;
      assert.equal(page.discover.meta.hasNextPage, Boolean(cursor));
    } while (cursor && pages < 10);
    assert.equal(pages, 3);
    assert.equal(new Set(seen).size, seen.length, "no duplicate across pages");
    assert.deepEqual([...seen].sort(), [...ids.discover, elsewhere.id].sort());
    assert.ok(!seen.some((id) => ids.attached.includes(id) || ids.unpublished.includes(id)));

    // Search narrows discovery only; attached stays complete.
    const searched = await call(`?q=disc-${key}-12`);
    assert.ok(searched.discover.items.length >= 1 && searched.discover.items.every((e: { slug: string }) => e.slug.includes(`disc-${key}-12`)));
    assert.equal(searched.attached.length, 60);
  } finally {
    await prisma.campaign.deleteMany({ where: { id: { in: [campaign.id, otherCampaign.id] } } });
    await prisma.experience.deleteMany({ where: { creatorId: profile.id } });
    await prisma.creatorProfile.delete({ where: { id: profile.id } });
    await prisma.brand.deleteMany({ where: { id: { in: [brand.id, otherBrand.id] } } });
    await prisma.user.delete({ where: { id: owner.id } });
  }
});
