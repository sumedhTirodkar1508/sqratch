process.env.APP_ENCRYPTION_KEY ||= "dummy-encryption-key-at-least-32-chars-long";
/** Opt-in only (REWARDS_WORKSPACE_REAL_DB=true, disposable loopback *_test database). Fixtures sit above each old cap. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { realDbTest } from "./helpers/real-db";

const { skipReason } = realDbTest("REWARDS_WORKSPACE_REAL_DB");
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function world() {
  const { default: prisma } = await import("../src/lib/prisma");
  const key = randomUUID().slice(0, 8);
  const brand = await prisma.brand.create({ data: { name: key, slug: key } });
  const other = await prisma.brand.create({ data: { name: `${key}-other`, slug: `${key}-other` } });
  const connection = await prisma.commerceConnection.create({ data: { brandId: brand.id, provider: "COMMERCE7", status: "CONNECTED", displayName: "Winery", externalAccountId: `${key}-c7`, isPrimary: true, providerMetadata: { currencyCode: "CAD" } } });
  const otherConnection = await prisma.commerceConnection.create({ data: { brandId: other.id, provider: "COMMERCE7", status: "CONNECTED", displayName: "Other", externalAccountId: `${key}-c7-other`, isPrimary: true, providerMetadata: { currencyCode: "CAD" } } });
  const user = await prisma.user.create({ data: { email: `${key}@example.test`, password: "synthetic-unused" } });
  const offer = (brandId: string, extra: Row = {}) => prisma.brandRewardOffer.create({ data: { brandId, provider: "COMMERCE7", connectionId: brandId === brand.id ? connection.id : otherConnection.id, sourceExternalAccountId: brandId === brand.id ? `${key}-c7` : `${key}-c7-other`, title: "Reward", isActive: true, pointsCost: 100, discountAmountCents: 1000, currencyCode: "CAD", maxTotalRedemptions: 25, maxRedemptionsPerUser: 1, commerce7Config: { eligibilityMode: "ANYONE_WITH_CODE", discountEnabled: true }, ...extra } });
  const ctx = (brandId = brand.id) => async () => ({ userId: "u", selectionRequired: false, brands: [], membership: { id: "m", role: "ADMIN", brand: { id: brandId, name: "B", slug: key } } }) as never;
  const cleanup = async () => {
    await prisma.commerceRewardRedemption.deleteMany({ where: { brandId: { in: [brand.id, other.id] } } });
    await prisma.brandRewardOffer.deleteMany({ where: { brandId: { in: [brand.id, other.id] } } });
    await prisma.connectedCommerceProduct.deleteMany({ where: { brandId: { in: [brand.id, other.id] } } });
    await prisma.commerceConnection.deleteMany({ where: { brandId: { in: [brand.id, other.id] } } });
    await prisma.brand.deleteMany({ where: { id: { in: [brand.id, other.id] } } });
    await prisma.user.deleteMany({ where: { id: user.id } });
  };
  return { prisma, key, brand, other, connection, otherConnection, user, offer, ctx, cleanup };
}
type World = Awaited<ReturnType<typeof world>>;

/** `count` claims, newest first by index; `shape(i)` sets status and flags. Claim i is created i minutes before the newest. */
async function claims(w: World, brandId: string, offerId: string, count: number, shape: (i: number) => Row, tag = "c") {
  const base = Date.now() - 60_000;
  await w.prisma.commerceRewardRedemption.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      userId: w.user.id, brandId, offerId, provider: "COMMERCE7" as const, idempotencyKey: `${w.key}-${tag}-${i}`, code: `SQRA-${w.key}-${tag}-${i}`, pointsCost: 100, discountAmountCents: 1000, rewardConfigSnapshot: { eligibilityMode: "ANYONE_WITH_CODE" }, connectionId: brandId === w.brand.id ? w.connection.id : w.otherConnection.id, externalAccountId: brandId === w.brand.id ? `${w.key}-c7` : `${w.key}-c7-other`,
      createdAt: new Date(base - i * 1000), status: "ISSUED" as const, provisioningState: "READY" as const, ...shape(i),
    })),
  });
  return Array.from({ length: count }, (_, i) => `${w.key}-${tag}-${i}`);
}
async function walk(w: World, query: string, limit = 50) {
  const { commerce7BrandClaimsGetImpl } = await import("../src/app/api/brand/rewards/commerce7/claims/route");
  const pages: Row[] = []; const keys: string[] = []; let cursor: string | null = null;
  do {
    const url = `https://sqratch.example/api/brand/rewards/commerce7/claims?limit=${limit}${query}${cursor ? `&cursor=${cursor}` : ""}`;
    const response = await commerce7BrandClaimsGetImpl(new NextRequest(url), { getContext: w.ctx() });
    assert.equal(response.status, 200); const body = await response.json(); pages.push(body);
    keys.push(...body.claims.map((claim: Row) => claim.id)); cursor = body.claimsPage.nextCursor;
  } while (cursor && pages.length < 80);
  return { pages, ids: keys };
}

test("Commerce7 claims page past 100, list unresolved work first, filter by status and never cross Brands", { skip: skipReason }, async () => {
  const { commerce7BrandRewardsGetImpl } = await import("../src/app/api/brand/rewards/commerce7/route");
  const w = await world();
  try {
    const offer = await w.offer(w.brand.id); const foreign = await w.offer(w.other.id);
    // 120 claims. The 6 OLDEST (indexes 114..119) need action; 1 mid-history claim is an old-style refund with a null state.
    await claims(w, w.brand.id, offer.id, 120, (i) => i >= 114 ? (i % 2 ? { status: "POINTS_DEBITED", provisioningState: "AWAITING_ELIGIBILITY" } : { needsManualReview: true, provisioningState: "MANUAL_REVIEW" }) : i === 60 ? { status: "REFUNDED", provisioningState: null } : i % 10 === 0 ? { status: "USED" } : {});
    await claims(w, w.other.id, foreign.id, 5, () => ({}), "foreign");
    const byIndex = new Map((await w.prisma.commerceRewardRedemption.findMany({ where: { brandId: w.brand.id }, select: { id: true, idempotencyKey: true } })).map((row) => [row.idempotencyKey, row.id]));

    const all = await walk(w, "&status=ALL");
    assert.equal(all.ids.length, 120, "every claim is reachable, not just the newest 100");
    assert.equal(new Set(all.ids).size, 120, "no claim repeats across pages");
    assert.deepEqual(all.pages.map((page) => page.claims.length), [50, 50, 20]);
    const rank = (index: number) => all.ids.indexOf(byIndex.get(`${w.key}-c-${index}`)!);
    assert.ok(rank(100) >= 0 && all.ids.length > 100, "the 101st claim is on page 3");
    for (const index of [114, 115, 116, 117, 118, 119]) assert.ok(rank(index) < 6, `needs-action claim ${index} is listed first`);
    assert.ok(rank(114) < rank(0), "an old claim needing action sits above the newest resolved claim");
    assert.ok(rank(0) < rank(1) && rank(1) < rank(113), "resolved claims stay newest first");
    assert.ok(rank(60) >= 6, "a null-state refund is resolved, not lost (null provisioning state must not drop it)");
    assert.deepEqual(all.pages[0].claimsPage, { filter: "ALL", nextCursor: all.pages[0].claimsPage.nextCursor, totalCount: 120, needsActionCount: 6 });

    const small = await walk(w, "&status=ALL", 4);
    assert.deepEqual(small.ids, all.ids, "paging across the needs-action boundary with a tiny page gives the same order");

    const needs = await walk(w, "&status=NEEDS_ACTION");
    assert.equal(needs.ids.length, 6);
    const used = await walk(w, "&status=USED");
    assert.equal(used.ids.length, 11, "status filter walks every matching claim (indexes 0,10,...,110)");
    assert.ok(used.pages.every((page) => page.claims.every((claim: Row) => claim.status === "USED")));
    const refunded = await walk(w, "&status=REFUNDED"); assert.equal(refunded.ids.length, 1);
    assert.ok(![...all.ids].some((id) => !byIndex.size || ![...byIndex.values()].includes(id)), "only this Brand's claims");

    // The workspace payload keeps its `claims` key (first page) and adds the cursor and true counts.
    const workspace = await (await commerce7BrandRewardsGetImpl(new NextRequest("https://sqratch.example/api/brand/rewards/commerce7"), { getContext: w.ctx() })).json();
    assert.equal(workspace.claims.length, 50); assert.equal(workspace.claimsPage.totalCount, 120); assert.equal(workspace.claimsPage.needsActionCount, 6); assert.ok(workspace.claimsPage.nextCursor);
    assert.deepEqual(workspace.claims.slice(0, 6).map((claim: Row) => claim.id).sort(), [114, 115, 116, 117, 118, 119].map((i) => byIndex.get(`${w.key}-c-${i}`)!).sort());

    for (const bad of ["status=BOGUS", "limit=0", "limit=101", "limit=abc", "cursor=not-a-cursor"]) {
      const { commerce7BrandClaimsGetImpl } = await import("../src/app/api/brand/rewards/commerce7/claims/route");
      assert.equal((await commerce7BrandClaimsGetImpl(new NextRequest(`https://sqratch.example/x?${bad}`), { getContext: w.ctx() })).status, 400, bad);
    }
    // A cursor minted for another filter's phase is refused rather than misread.
    const cursor = all.pages[0].claimsPage.nextCursor as string;
    const { commerce7BrandClaimsGetImpl } = await import("../src/app/api/brand/rewards/commerce7/claims/route");
    assert.equal((await commerce7BrandClaimsGetImpl(new NextRequest(`https://sqratch.example/x?status=NEEDS_ACTION&cursor=${cursor}`), { getContext: w.ctx() })).status, 400);
  } finally { await w.cleanup(); }
});

test("rewards providers: a provider is listed when it has any connection, offer or claim, even disconnected", { skip: skipReason }, async () => {
  const { providersGetImpl } = await import("../src/app/api/brand/rewards/providers/route");
  const w = await world();
  try {
    const run = async () => (await (await providersGetImpl({ getContext: w.ctx() })).json()).providers as Row[];
    // Commerce7 is connected; Shopify has nothing at all.
    let providers = await run();
    assert.equal(providers.find((p) => p.provider === "COMMERCE7")!.visible, true); assert.equal(providers.find((p) => p.provider === "COMMERCE7")!.connection.usable, true);
    assert.equal(providers.find((p) => p.provider === "SHOPIFY")!.visible, false); assert.equal(providers.find((p) => p.provider === "SHOPIFY")!.connection, null);
    // Shopify once had an offer and a claim, and is now disconnected: it stays listed, read-only.
    await w.prisma.commerceConnection.create({ data: { brandId: w.brand.id, provider: "SHOPIFY", status: "DISCONNECTED", displayName: "Shop", externalAccountId: `${w.key}.myshopify.com`, isPrimary: false } });
    const shopifyOffer = await w.prisma.brandRewardOffer.create({ data: { brandId: w.brand.id, provider: "SHOPIFY", title: "Old Shopify offer", pointsCost: 100, discountAmountCents: 500, currencyCode: "CAD", sourceExternalAccountId: `${w.key}.myshopify.com` } });
    await claims(w, w.brand.id, shopifyOffer.id, 1, () => ({ provider: "SHOPIFY" }), "shop");
    providers = await run();
    const shopify = providers.find((p) => p.provider === "SHOPIFY")!;
    assert.equal(shopify.visible, true); assert.equal(shopify.connection.usable, false); assert.equal(shopify.connection.status, "DISCONNECTED"); assert.equal(shopify.offerCount, 1); assert.equal(shopify.claimCount, 1);
    // Losing the connection row entirely keeps the history visible.
    await w.prisma.commerceConnection.deleteMany({ where: { brandId: w.brand.id, provider: "SHOPIFY" } });
    providers = await run(); assert.equal(providers.find((p) => p.provider === "SHOPIFY")!.visible, true);
    // Commerce7 disconnecting does not hide it either.
    await w.prisma.commerceConnection.update({ where: { id: w.connection.id }, data: { status: "DISCONNECTED" } });
    providers = await run(); const c7 = providers.find((p) => p.provider === "COMMERCE7")!; assert.equal(c7.visible, true); assert.equal(c7.connection.usable, false);
  } finally { await w.cleanup(); }
});

// ── Catalog: a 600-product connection, above the old 500-by-title window ───────

const TAG = "00000000-0000-4000-8000-0000000000a1"; const OTHER_TAG = "00000000-0000-4000-8000-0000000000a2";
const secured = (availableTo: string, ids: string[]) => ({ security: { availableTo, displayOption: "Display Product / Show Login", availableToObjectIds: ids } });
const wineId = (i: number) => `wine-${String(i).padStart(3, "0")}`;

async function catalog(w: World) {
  const metadataFor = (i: number): unknown => {
    if (i === 575) return secured("Tag", [TAG]);                 // beyond position 500, Tag-secured
    if (i === 590) return secured("Tag", [TAG, OTHER_TAG]);      // beyond position 500, two tags, shares TAG with 575
    if (i === 10) return secured("Tag", [OTHER_TAG]);
    if (i < 100) return secured("Public", []);                    // known, not exclusive
    if (i % 100 === 99) return { sync: "no-security-key" };       // an object without a security key: unknown
    if (i % 100 === 98) return null;                              // no metadata at all: unknown
    if (i < 300) return secured("Public", []);
    return i < 560 ? null : secured("Allocation", ["allocation-id"]);
  };
  await w.prisma.connectedCommerceProduct.createMany({ data: Array.from({ length: 600 }, (_, i) => ({
    brandId: w.brand.id, connectionId: w.connection.id, provider: "COMMERCE7" as const, externalId: wineId(i), externalKey: wineId(i), title: `Wine ${String(i).padStart(3, "0")}`, productUrl: "", images: [], externalVariantIds: [],
    providerMetadata: metadataFor(i) as never,
  })) });
  // Unavailable and foreign rows never count, list or resolve.
  await w.prisma.connectedCommerceProduct.create({ data: { brandId: w.brand.id, connectionId: w.connection.id, provider: "COMMERCE7", externalId: "retired", externalKey: "retired", title: "Wine retired", productUrl: "", images: [], externalVariantIds: [], isAvailable: false, providerMetadata: secured("Tag", [TAG]) as never } });
  await w.prisma.connectedCommerceProduct.create({ data: { brandId: w.other.id, connectionId: w.otherConnection.id, provider: "COMMERCE7", externalId: "foreign", externalKey: "foreign", title: "Wine foreign", productUrl: "", images: [], externalVariantIds: [], providerMetadata: null as never } });
  return Array.from({ length: 600 }, (_, i) => ({ id: wineId(i), title: `Wine ${String(i).padStart(3, "0")}`, metadata: metadataFor(i) }));
}
/** The pre-P29 definition, evaluated in JS over ALL rows: the diagnostic must equal this, not a count over a page. */
const isUnknown = (metadata: unknown) => !metadata || typeof metadata !== "object" || Array.isArray(metadata) || !("security" in (metadata as object));

test("catalog picker pages and searches the full ConnectedCommerceProduct set; a product beyond position 500 is selectable and titled on its offer", { skip: skipReason }, async () => {
  const { commerce7BrandProductsGetImpl } = await import("../src/app/api/brand/rewards/commerce7/products/route");
  const { commerce7BrandRewardsGetImpl } = await import("../src/app/api/brand/rewards/commerce7/route");
  const { saveCommerce7Offer } = await import("../src/lib/commerce7-rewards");
  const w = await world();
  try {
    const fixture = await catalog(w);
    const expectedUnknown = fixture.filter((product) => isUnknown(product.metadata)).length;
    assert.ok(expectedUnknown > 0 && expectedUnknown < 600, "fixture has both known and unknown security");
    const get = async (query: string) => { const response = await commerce7BrandProductsGetImpl(new NextRequest(`https://sqratch.example/api/brand/rewards/commerce7/products?${query}`), { getContext: w.ctx() }); return { status: response.status, body: await response.json() as Row }; };
    const walk = async (query: string, limit = 100) => { const ids: string[] = []; let cursor: string | null = null; let pages = 0; do { const { status, body } = await get(`limit=${limit}${query}${cursor ? `&cursor=${cursor}` : ""}`); assert.equal(status, 200); ids.push(...body.products.map((product: Row) => product.externalId)); cursor = body.nextCursor; pages++; } while (cursor && pages < 50); return ids; };

    const everything = await walk("");
    assert.equal(everything.length, 600, "every available product is reachable, not the first 500"); assert.equal(new Set(everything).size, 600);
    assert.ok(everything.includes(wineId(599)) && everything.includes(wineId(575)), "products past position 500 are listed"); assert.ok(!everything.includes("retired") && !everything.includes("foreign"));
    assert.deepEqual(everything, fixture.map((product) => product.id), "ordered by title");
    const first = await get("limit=50"); assert.equal(first.body.products.length, 50); assert.ok(first.body.nextCursor);
    assert.ok(first.body.products.every((product: Row) => JSON.stringify(Object.keys(product).sort()) === JSON.stringify(["externalId", "title"])), "titles and ids only");
    assert.ok(!JSON.stringify(first.body).includes("security") && !JSON.stringify(first.body).includes(TAG), "no security metadata leaves the server");

    const searched = await get("q=wine%20575"); assert.deepEqual(searched.body.products, [{ externalId: wineId(575), title: "Wine 575" }], "search is case-insensitive and reaches past position 500");
    assert.equal((await walk("&q=Wine%205")).length, 100, "search pages too (Wine 500..599)");
    const exclusive = await walk("&mode=exclusive"); assert.deepEqual(exclusive, [wineId(10), wineId(575), wineId(590)], "only Tag-secured products, including both beyond 500; Public, Allocation and unavailable rows are not offered");
    assert.deepEqual((await get("mode=exclusive&q=590")).body.products, [{ externalId: wineId(590), title: "Wine 590", tagCount: 2 }]);
    for (const bad of ["mode=bogus", "limit=0", "limit=101", `q=${"x".repeat(101)}`]) assert.equal((await get(bad)).status, 400, bad);
    const foreignBrand = await commerce7BrandProductsGetImpl(new NextRequest("https://sqratch.example/x?q=foreign"), { getContext: w.ctx(w.other.id) });
    assert.deepEqual((await foreignBrand.json()).products.map((product: Row) => product.externalId), ["foreign"], "each Brand sees only its own catalog");

    // Saving an offer re-validates the product in the database, independent of any picker list (U-26).
    const input = { eligibilityMode: "ANYONE_WITH_CODE", title: "Beyond the window", isActive: false, rewardMode: "DISCOUNT", appliesTo: "SPECIFIC_PRODUCTS", discountType: "FIXED_AMOUNT", discountAmountCents: 1000, pointsCost: 100, maxTotalRedemptions: 25, maxRedemptionsPerUser: 1, codeValidDays: 30, productIds: [wineId(599)] };
    const deps = { db: w.prisma, client: (): never => { throw new Error("offer save must not use the provider"); }, now: () => new Date() };
    const saved = await saveCommerce7Offer(w.brand.id, input, undefined, deps as never);
    assert.equal(saved.brandId, w.brand.id);
    await assert.rejects(saveCommerce7Offer(w.brand.id, { ...input, productIds: ["foreign"] }, undefined, deps as never), { code: "INVALID_OFFER" }, "a product of another Brand is refused whatever the picker showed");
    // An exclusive offer on a product beyond the window, plus a discount offer referencing the 600th product.
    await w.prisma.brandRewardOffer.create({ data: { brandId: w.brand.id, provider: "COMMERCE7", connectionId: w.connection.id, sourceExternalAccountId: `${w.key}-c7`, title: "Rare access", isActive: false, rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", appliesTo: "SPECIFIC_PRODUCTS", pointsCost: 100, discountAmountCents: null, currencyCode: "CAD", maxTotalRedemptions: 25, maxRedemptionsPerUser: 1,
      commerce7Config: { eligibilityMode: "CLAIMANT_ONLY", discountEnabled: false, exclusiveAccess: { productId: wineId(575), securityAvailableTo: "Tag", securityTagId: TAG, tagTitle: "Rare" } }, products: { create: [{ externalProductId: wineId(575), title: "Wine 575" }] } } });

    const workspace = await (await commerce7BrandRewardsGetImpl(new NextRequest("https://sqratch.example/api/brand/rewards/commerce7"), { getContext: w.ctx() })).json();
    assert.equal(workspace.exclusiveDiagnostics.securityUnknownCount, expectedUnknown, "the diagnostic equals a direct count over all products");
    const stored = await w.prisma.connectedCommerceProduct.findMany({ where: { brandId: w.brand.id, connectionId: w.connection.id, isAvailable: true }, select: { providerMetadata: true } });
    assert.equal(stored.length, 600); assert.equal(workspace.exclusiveDiagnostics.securityUnknownCount, stored.filter((row) => isUnknown(row.providerMetadata)).length, "and equals the old rule applied to every stored row");
    const titles = Object.fromEntries(workspace.referencedProducts.map((product: Row) => [product.externalId, product.title]));
    assert.equal(titles[wineId(599)], "Wine 599", "the title of a product beyond position 500 resolves by direct lookup"); assert.equal(titles[wineId(575)], "Wine 575");
    const rare = workspace.offers.find((offer: Row) => offer.title === "Rare access");
    assert.equal(rare.exclusiveAccessStatus, "CONFIGURED", "the exclusive status is judged on the real product row, not a window"); assert.equal(rare.exclusiveTagCount, 1);
    assert.equal(rare.exclusiveSharedProductCount, 1, "Wine 590 also carries the tag; counted over the whole catalog");
    assert.equal(workspace.products.length, 50); assert.ok(workspace.productsPage.nextCursor);
    assert.deepEqual(workspace.exclusiveProducts.map((product: Row) => product.externalId), [wineId(10), wineId(575), wineId(590)]);
    assert.ok(!JSON.stringify(workspace).includes(TAG) && !JSON.stringify(workspace).includes("allocation-id"), "no tag ids or security data in the Brand payload");

    // With the connection gone, the workspace still resolves offer titles from the offers' own connection and shows history.
    await w.prisma.commerceConnection.update({ where: { id: w.connection.id }, data: { status: "DISCONNECTED" } });
    const history = await (await commerce7BrandRewardsGetImpl(new NextRequest("https://sqratch.example/api/brand/rewards/commerce7"), { getContext: w.ctx() })).json();
    assert.equal(history.providers.COMMERCE7, false); assert.equal(history.offers.length, 2);
    assert.equal(history.referencedProducts.find((product: Row) => product.externalId === wineId(599)).title, "Wine 599");
  } finally { await w.cleanup(); }
});
