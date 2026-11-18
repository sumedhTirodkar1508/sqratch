import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { realDbTest } from "./helpers/real-db";

const { skipReason } = realDbTest("COMMERCE7_OFFERS_REAL_DB");

test("Commerce7 offers page past the old newest-100 window and an older offer stays reachable", { skip: skipReason }, async () => {
  const { default: prisma } = await import("../src/lib/prisma");
  const { commerce7BrandRewardsGetImpl } = await import("../src/app/api/brand/rewards/commerce7/route");
  const key = randomUUID();
  const brand = await prisma.brand.create({ data: { name: key, slug: key } });
  const other = await prisma.brand.create({ data: { name: `${key}-o`, slug: `${key}-o` } });
  try {
    const connect = (brandId: string) => prisma.commerceConnection.create({ data: { brandId, provider: "COMMERCE7", status: "CONNECTED", externalAccountId: `tenant-${brandId}`, displayName: "Synthetic", providerMetadata: { currencyCode: "CAD" } } });
    const [c1, c2] = await Promise.all([connect(brand.id), connect(other.id)]);
    const base = Date.now() - 1_000_000_000;
    const make = (brandId: string, n: number) =>
      ({ brandId, provider: "COMMERCE7" as const, connectionId: brandId === brand.id ? c1.id : c2.id, sourceExternalAccountId: `tenant-${brandId}`, currencyCode: "CAD", maxTotalRedemptions: 25, maxRedemptionsPerUser: 1, isActive: true, commerce7Config: { eligibilityMode: "ANYONE_WITH_CODE", discountEnabled: true }, title: `Offer ${String(n).padStart(3, "0")}`, pointsCost: 10, discountAmountCents: 100, createdAt: new Date(base + n * 1000) });
    await prisma.brandRewardOffer.createMany({ data: [...Array.from({ length: 130 }, (_, n) => make(brand.id, n)), make(other.id, 999)] });

    const context = async () => ({ membership: { brand: { id: brand.id } } }) as never;
    const get = async (query = "") => {
      const response = await commerce7BrandRewardsGetImpl(new NextRequest(`http://localhost/api/brand/rewards/commerce7${query}`), { getContext: context });
      assert.equal(response.status, 200);
      return (await response.json()) as { offers: Array<{ id: string; title: string }>; offersPage: { nextCursor: string | null; totalCount: number }; claims: unknown[] };
    };

    const first = await get();
    assert.equal(first.offers.length, 50);
    assert.equal(first.offersPage.totalCount, 130, "total counts only this brand's offers");
    assert.equal(first.offers[0].title, "Offer 129", "newest first");
    assert.ok(first.offersPage.nextCursor);

    const seen = new Set(first.offers.map((o) => o.id));
    let page = first;
    let pages = 1;
    while (page.offersPage.nextCursor) {
      page = await get(`?offersCursor=${encodeURIComponent(page.offersPage.nextCursor)}`);
      pages += 1;
      for (const offer of page.offers) { assert.ok(!seen.has(offer.id), "no offer repeats across pages"); seen.add(offer.id); }
    }
    assert.equal(pages, 3);
    assert.equal(seen.size, 130, "every offer is reachable, including the oldest");
    assert.ok(page.offers.some((o) => o.title === "Offer 000"), "the oldest offer is on the last page");

    // A small page size works and another brand's offers never appear.
    const small = await get("?offersLimit=7");
    assert.equal(small.offers.length, 7);
    assert.ok(small.offers.every((o) => o.title !== "Offer 999"));
    // Another brand's offer id never positions a page.
    const foreign = await prisma.brandRewardOffer.findFirstOrThrow({ where: { brandId: other.id }, select: { id: true } });
    const foreignCursor = await commerce7BrandRewardsGetImpl(new NextRequest(`http://localhost/api/brand/rewards/commerce7?offersCursor=${foreign.id}`), { getContext: context });
    assert.equal(foreignCursor.status, 400);
    const bad = await commerce7BrandRewardsGetImpl(new NextRequest("http://localhost/api/brand/rewards/commerce7?offersLimit=0"), { getContext: context });
    assert.equal(bad.status, 400);
  } finally {
    await prisma.brandRewardOffer.deleteMany({ where: { brandId: { in: [brand.id, other.id] } } });
    await prisma.commerceConnection.deleteMany({ where: { brandId: { in: [brand.id, other.id] } } });
    await prisma.brand.deleteMany({ where: { id: { in: [brand.id, other.id] } } });
  }
});
