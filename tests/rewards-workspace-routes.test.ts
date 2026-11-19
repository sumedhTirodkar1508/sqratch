import "./env-setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NextRequest, NextResponse } from "next/server";
import { providersGetImpl } from "../src/app/api/brand/rewards/providers/route";
import { commerce7BrandClaimsGetImpl } from "../src/app/api/brand/rewards/commerce7/claims/route";
import { commerce7BrandProductsGetImpl } from "../src/app/api/brand/rewards/commerce7/products/route";
import { parseCommerce7CatalogQuery, parseCommerce7ClaimQuery } from "../src/lib/commerce7-brand-rewards-read";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const brandContext = (id = "brand") => async () => ({ membership: { brand: { id } } }) as never;
const noBrand = async () => null as never;

// ── Customer Shopify redemptions: bounded and paged ───────────────────────────

function redemptionsRoute(rows: Row[], user: string | null = "user") {
  const exports: Record<string, (request?: unknown) => Promise<Response>> = {};
  const queries: Row[] = [];
  const db = { commerceRewardRedemption: {
    findFirst: async ({ where }: { where: Row }) => rows.find((row) => row.id === where.id && row.userId === where.userId) ?? null,
    findMany: async (args: Row) => { queries.push(args); const mine = rows.filter((row) => row.userId === args.where.userId); const start = args.cursor ? mine.findIndex((row) => row.id === args.cursor.id) + (args.skip ?? 0) : 0; return mine.slice(start, start + args.take); },
  } };
  runInNewContext(ts.transpileModule(readFileSync("src/app/api/rewards/shopify/redemptions/route.ts", "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, Number, require(name: string) {
      const dependencies: Record<string, unknown> = { "next/server": { NextResponse }, "next-auth": { getServerSession: async () => user ? { user: { id: user } } : null }, "@/app/api/auth/[...nextauth]/options": { authOptions: {} }, "@/lib/prisma": { __esModule: true, default: db }, "@/lib/commerce/connection-service": { deriveShopifyStorefrontUrl: (id: string) => `https://${id}` } };
      if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`); return dependencies[name];
    },
  });
  const call = (query = "") => exports.GET({ nextUrl: new URL(`https://sqratch.example/api/rewards/shopify/redemptions${query}`) });
  return { call, queries };
}
const redemption = (index: number, userId = "user") => ({ id: `r${String(index).padStart(3, "0")}`, userId, code: `CODE${index}`, status: "ISSUED", brand: { id: "b", name: "B", logoUrl: null }, offer: { id: "o", title: "O" }, issuedAt: null, expiresAt: null, usedAt: null, pointsCost: 10, discountType: "FIXED_AMOUNT", discountAmountCents: 100, discountPercentageBasisPoints: null, currencyCode: "CAD", externalDiscountStatus: null, externalUsageCount: null, providerLastCheckedAt: null, externalAccountId: "shop.myshopify.com" });

test("customer redemptions are bounded and paged: never more than the limit, newest first, every row reachable, only the caller's rows", async () => {
  const rows = [...Array.from({ length: 120 }, (_, i) => redemption(i)), redemption(999, "someone-else")];
  const app = redemptionsRoute(rows);
  const first = await app.call(); const body = await first.json();
  assert.equal(first.status, 200); assert.equal(body.data.length, 25, "default page is bounded"); assert.equal(body.pagination.hasMore, true);
  assert.equal(app.queries[0].take, 26, "one extra row detects the next page"); assert.equal(JSON.stringify(app.queries[0].orderBy), JSON.stringify([{ createdAt: "desc" }, { id: "desc" }]));
  assert.equal(body.data[0].shopifyDiscountStatus, null, "the established response keys stay"); assert.equal(body.data[0].shopUrl, "https://shop.myshopify.com");
  const seen: string[] = body.data.map((row: Row) => row.id); let cursor = body.pagination.nextCursor as string | null; let pages = 1;
  while (cursor) { const page = await (await app.call(`?limit=50&cursor=${cursor}`)).json(); assert.ok(page.data.length <= 50); seen.push(...page.data.map((row: Row) => row.id)); cursor = page.pagination.nextCursor; pages++; }
  assert.equal(seen.length, 120, "the 101st and later redemptions are reachable"); assert.equal(new Set(seen).size, 120); assert.ok(!seen.includes("r999"), "another customer's rows are never listed"); assert.equal(pages, 3);
});

test("customer redemptions reject bad limits, foreign or missing cursors and anonymous callers", async () => {
  const app = redemptionsRoute([redemption(1), redemption(2), redemption(3, "someone-else")]);
  for (const query of ["?limit=0", "?limit=51", "?limit=abc", "?limit=1.5", "?cursor="]) assert.equal((await app.call(query)).status, 400, query);
  assert.equal((await app.call("?cursor=r003")).status, 400, "another customer's id is not a valid cursor"); assert.equal((await app.call("?cursor=missing")).status, 400);
  assert.equal((await redemptionsRoute([], null).call()).status, 401);
  assert.equal((await app.call("?limit=1")).status, 200);
});

// ── Provider presence: shown whenever there is any connection, offer or claim ──

const connection = (provider: string, status: string) => ({ provider, status, displayName: provider, externalAccountId: "x", installedAt: new Date(1) });
const presence = (connections: Row[], offers: Row = {}, claims: Row = {}, failedProviders: string[] = []) => providersGetImpl({ getContext: brandContext(), getConnections: async () => ({ connections, complete: failedProviders.length === 0, failedProviders }) as never, countByProvider: async () => ({ offers, claims }) });
const visible = async (response: Response) => Object.fromEntries(((await response.json()).providers as Row[]).map((entry) => [entry.provider, entry]));

test("a provider is listed when it has any connection, offer or claim, and a disconnected one stays listed as not usable", async () => {
  let providers = await visible(await presence([connection("COMMERCE7", "CONNECTED")]));
  assert.equal(providers.COMMERCE7.visible, true); assert.equal(providers.SHOPIFY.visible, false);
  providers = await visible(await presence([connection("COMMERCE7", "CONNECTED"), connection("SHOPIFY", "DISCONNECTED")]));
  assert.equal(providers.SHOPIFY.visible, true); assert.equal(providers.SHOPIFY.connection.usable, false); assert.equal(providers.COMMERCE7.connection.usable, true);
  providers = await visible(await presence([connection("COMMERCE7", "CONNECTED")], { SHOPIFY: 2 })); assert.equal(providers.SHOPIFY.visible, true, "offers alone keep a provider"); assert.equal(providers.SHOPIFY.connection, null);
  providers = await visible(await presence([], {}, { SHOPIFY: 1 })); assert.equal(providers.SHOPIFY.visible, true, "a claim alone keeps a provider");
  providers = await visible(await presence([], {}, {}, ["COMMERCE7"])); assert.equal(providers.COMMERCE7.visible, true, "an unknown state never hides a workspace"); assert.equal(providers.SHOPIFY.visible, false);
  providers = await visible(await presence([connection("SHOPIFY", "UNINSTALLED"), connection("SHOPIFY", "CONNECTED")])); assert.equal(providers.SHOPIFY.connection.usable, true, "the usable connection represents the provider");
  assert.equal((await providersGetImpl({ getContext: noBrand })).status, 403);
});

test("Commerce7 claims endpoint rejects bad parameters before any query and refuses callers without a Brand", async () => {
  const request = (query: string) => new NextRequest(`https://sqratch.example/api/brand/rewards/commerce7/claims?${query}`);
  for (const query of ["status=BOGUS", "limit=0", "limit=101", "limit=x", "cursor=%%%"]) assert.equal((await commerce7BrandClaimsGetImpl(request(query), { getContext: brandContext() })).status, 400, query);
  assert.equal((await commerce7BrandClaimsGetImpl(request("status=ALL"), { getContext: noBrand })).status, 403);
  assert.deepEqual(parseCommerce7ClaimQuery(null), { filter: "ALL", limit: 50, cursor: null });
  assert.throws(() => parseCommerce7ClaimQuery(new URLSearchParams({ cursor: Buffer.from(JSON.stringify({ p: "Z", t: "2026-01-01", i: "x" })).toString("base64url") })));
});

// ── The workspace shell: URL-held, never automatic ────────────────────────────

test("the rewards page keeps the provider in the URL, never switches on its own, and renders the selector inside the shell", () => {
  const page = readFileSync("src/app/(withSidebar)/dashboard/brand/rewards/page.tsx", "utf8");
  assert.match(page, /searchParams\.get\("provider"\)/); assert.match(page, /params\.set\("provider", provider\)/);
  assert.ok(!/setProvider\(/.test(page) && !/useState<"SHOPIFY" \| "COMMERCE7">/.test(page), "no provider state that a data load could overwrite");
  assert.ok(!/providers\.COMMERCE7 && !providers\.SHOPIFY/.test(page), "the old 'Shopify unusable, so show Commerce7' rule is gone");
  const shell = page.slice(page.indexOf("<BrandPageShell title=\"Rewards\""), page.indexOf("</BrandPageShell>"));
  assert.match(shell, /role="tablist"/, "the selector is a child of BrandPageShell"); assert.match(shell, /Reconnect \{PROVIDER_LABEL\[selected\]\}/, "a disconnected provider offers reconnect");
  assert.equal(page.match(/<BrandPageShell/g)?.length, 1, "one shell for both providers");
  assert.match(page, /available\.includes\(provider\) \|\| provider === selected/, "an explicitly selected provider is never dropped");
});

test("Commerce7 catalog endpoint validates parameters before any query and refuses callers without a Brand", async () => {
  const request = (query: string) => new NextRequest(`https://sqratch.example/api/brand/rewards/commerce7/products?${query}`);
  for (const query of ["mode=other", "limit=0", "limit=101", "limit=1.5", `q=${"x".repeat(101)}`, "cursor="]) assert.equal((await commerce7BrandProductsGetImpl(request(query), { getContext: brandContext() })).status, 400, query);
  assert.equal((await commerce7BrandProductsGetImpl(request("q=wine"), { getContext: noBrand })).status, 403);
  assert.deepEqual(parseCommerce7CatalogQuery(new URLSearchParams({ q: "  Rare  ", mode: "exclusive", limit: "20" })), { q: "Rare", exclusiveOnly: true, limit: 20, cursor: null });
  assert.deepEqual(parseCommerce7CatalogQuery(null), { q: "", exclusiveOnly: false, limit: 50, cursor: null });
});

test("the Brand route no longer caps its catalog or claims: no fixed windows remain in the workspace read path", () => {
  const route = readFileSync("src/app/api/brand/rewards/commerce7/route.ts", "utf8"); const lib = readFileSync("src/lib/commerce7-brand-rewards-read.ts", "utf8"); const tags = readFileSync("src/app/api/brand/rewards/commerce7/exclusive-tags/route.ts", "utf8");
  assert.ok(!/take: 500/.test(route) && !/take: 500/.test(tags), "no 500-by-title window"); assert.ok(!/\.filter\(\(product\) => \{ const metadata/.test(route), "the diagnostic is not computed from a list");
  assert.match(lib, /countCommerce7SecurityUnknown[\s\S]*connectedCommerceProduct\.count/, "the security diagnostic is a database count"); assert.ok(!/take: 100/.test(lib));
});

test("the customer redemptions client pages through the bounded endpoint", () => {
  const client = readFileSync("src/components/rewards/shopify-rewards-client.tsx", "utf8");
  assert.match(client, /limit: String\(REDEMPTION_PAGE_SIZE\)/); assert.match(client, /Load more redemptions/); assert.ok(!client.includes('fetchJson<ShopifyRewardRedemption[]>("/api/rewards/shopify/redemptions")'), "no unbounded list read");
});
