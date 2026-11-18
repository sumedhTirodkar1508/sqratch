/* eslint-disable @typescript-eslint/no-explicit-any -- loose Prisma-shaped fixtures */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NextResponse } from "next/server";
import { getAllCommerceConnectionsForBrands } from "../src/lib/commerce/connection-service";
import type { CommerceConnectionRow } from "../src/lib/commerce/connection-resolver";

type Handler = (request: Request, context?: { params: Promise<{ id: string }> }) => Promise<Response>;

function load(file: string, modules: Record<string, unknown>) {
  const exports: Record<string, Handler> = {};
  const source = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  runInNewContext(source, {
    exports, console, Date, Array, Set, Map, Boolean, String, URL,
    require: (id: string) => { if (!(id in modules)) throw new Error(`Unexpected dependency ${id}`); return modules[id]; },
  });
  return exports;
}

function row(brandId: string, provider: "SHOPIFY" | "COMMERCE7", overrides: Partial<CommerceConnectionRow> = {}): CommerceConnectionRow {
  return {
    id: `${brandId}-${provider}`, brandId, provider, status: "CONNECTED", displayName: `${provider} label`,
    externalAccountId: `${provider.toLowerCase()}-${brandId}`, storefrontUrl: null, isPrimary: false, grantedScopes: null,
    installedAt: null, uninstalledAt: null, lastProductSyncAt: null, createdAt: new Date("2026-01-01"), providerMetadata: null,
    ...overrides,
  } as CommerceConnectionRow;
}

const admin = { getAdminContext: async () => ({ userId: "admin", role: "ADMIN" }) };
const notAdmin = { getAdminContext: async () => null };

test("batched all-provider connection lookup is one query and keeps Commerce7-only brands", async () => {
  let queries = 0;
  const rows = [row("b1", "COMMERCE7"), row("b2", "SHOPIFY"), row("b2", "COMMERCE7", { status: "REQUIRES_RECONNECT" })];
  const result = await getAllCommerceConnectionsForBrands(["b1", "b2", "b3", "b1"], {
    findAllConnectionRowsForBrands: async (ids) => { queries++; assert.deepEqual(ids, ["b1", "b2", "b3"]); return rows; },
  });
  assert.equal(queries, 1);
  assert.equal(result.complete, true);
  assert.deepEqual(result.byBrand.get("b1")?.map((c) => c.provider), ["COMMERCE7"]);
  assert.deepEqual(result.byBrand.get("b2")?.map((c) => c.status), ["CONNECTED", "REQUIRES_RECONNECT"]);
  assert.equal(result.byBrand.has("b3"), false);

  const failed = await getAllCommerceConnectionsForBrands(["b1"], { findAllConnectionRowsForBrands: async () => { throw new Error("down"); } });
  assert.equal(failed.complete, false);
  let skipped = 0;
  await getAllCommerceConnectionsForBrands([], { findAllConnectionRowsForBrands: async () => { skipped++; return []; } });
  assert.equal(skipped, 0);
});

test("admin brands lists every canonical connection without N+1 and keeps shopifyShopDomain", async () => {
  const brands = Array.from({ length: 25 }, (_, i) => ({ id: `b${i}`, name: `Brand ${i}`, slug: `brand-${i}`, bio: null, websiteUrl: null, logoUrl: null, isActive: true, createdAt: new Date(), members: [], campaigns: [] }));
  let brandQueries = 0;
  let connectionQueries = 0;
  const rows = [row("b0", "COMMERCE7", { displayName: "Napa Cellars", externalAccountId: "tenant-9", providerMetadata: { secretLike: "x" } }), row("b1", "SHOPIFY"), row("b1", "COMMERCE7")];
  const { getAllCommerceConnectionsForBrands: real } = await import("../src/lib/commerce/connection-service");
  const routes = load("src/app/api/admin/brands/route.ts", {
    "next/server": { NextResponse },
    "@prisma/client": { CommerceProvider: { SHOPIFY: "SHOPIFY", COMMERCE7: "COMMERCE7" } },
    "@/lib/admin-auth": admin,
    "@/lib/prisma": { __esModule: true, default: { brand: { findMany: async () => { brandQueries++; return brands; } } } },
    "@/lib/commerce/connection-service": {
      getActiveCommerceConnectionsForBrands: async () => new Map([["b1", { externalAccountId: "shop.myshopify.com" }]]),
      getAllCommerceConnectionsForBrands: (ids: string[]) => real(ids, { findAllConnectionRowsForBrands: async () => { connectionQueries++; return rows; } }),
    },
  });
  const response = await routes.GET(new Request("https://example.test"));
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(brandQueries, 1);
  assert.equal(connectionQueries, 1, "one batched connection query for 25 brands");
  assert.equal(JSON.stringify(data[0].connections), JSON.stringify([{ id: "b0-COMMERCE7", provider: "COMMERCE7", status: "CONNECTED", isPrimary: false, externalAccountLabel: "Napa Cellars", externalAccountId: "tenant-9" }]));
  assert.equal(data[0].shopifyShopDomain, null);
  assert.equal(data[1].shopifyShopDomain, "shop.myshopify.com");
  assert.equal(data[1].connections.length, 2);
  assert.deepEqual(data[2].connections, []);
  assert.equal(data[0].connectionsComplete, true);
  assert.doesNotMatch(JSON.stringify(data), /secretLike|providerMetadata|grantedScopes|encryptedPayload/);

  const denied = load("src/app/api/admin/brands/route.ts", {
    "next/server": { NextResponse }, "@prisma/client": { CommerceProvider: {} }, "@/lib/admin-auth": notAdmin,
    "@/lib/prisma": { __esModule: true, default: {} }, "@/lib/commerce/connection-service": {},
  });
  assert.equal((await denied.GET(new Request("https://example.test"))).status, 403);
});

function userRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `u${i}`, name: `User ${i}`, email: `u${i}@example.test`, role: "BRAND_ADMIN", isEmailVerified: true, createdAt: new Date(), isActive: true,
    creatorProfile: null,
    brandMembers: Array.from({ length: Math.min(3, 7) }, (_, k) => ({ id: `m${k}`, role: "ADMIN", brand: { id: `b${k}`, name: `Brand ${k}`, slug: `brand-${k}` } })),
    _count: { brandMembers: i === 0 ? 7 : 3 },
  }));
}

test("both admin user list routes return the membership total next to the three-item preview", async () => {
  const seenSelects: any[] = [];
  const db = { user: { findMany: async (args: any) => { seenSelects.push(args.select); return userRows(2); } } };
  const usersRoute = load("src/app/api/admin/users/route.ts", {
    "next/server": { NextResponse },
    "@/lib/admin-auth": { ...admin, normalizeUserRole: () => null },
    "@/lib/prisma": { __esModule: true, default: db },
    "@/lib/admin-user-mutations": { changeUserAccess: async () => ({}), adminMutationError: () => null },
  });
  const siblingRoute = load("src/app/api/admin/user-management/get-or-create-users/route.ts", {
    "next/server": { NextResponse },
    "@/lib/prisma": { __esModule: true, default: db },
    "next-auth/next": { getServerSession: async () => ({ user: { role: "ADMIN" } }) },
    "@/app/api/auth/[...nextauth]/options": { authOptions: {} },
    bcryptjs: {}, "@/lib/auth/email-verification": {}, "@/lib/password-policy": {}, "@/lib/admin-auth": { normalizeUserRole: () => null }, "@/lib/prisma-errors": {},
  });
  for (const response of [await usersRoute.GET({ nextUrl: { searchParams: new URLSearchParams() } } as unknown as Request), await siblingRoute.GET(new Request("https://example.test/api"))]) {
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data[0].brandMembershipCount, 7);
    assert.equal(data[0].brands.length, 3, "list keeps the cheap three-item preview");
    assert.equal(data[1].brandMembershipCount, 3);
  }
  for (const select of seenSelects) assert.equal(JSON.stringify(select._count), JSON.stringify({ select: { brandMembers: true } }));

  const guarded = load("src/app/api/admin/users/route.ts", {
    "next/server": { NextResponse }, "@/lib/admin-auth": { ...notAdmin, normalizeUserRole: () => null },
    "@/lib/prisma": { __esModule: true, default: db }, "@/lib/admin-user-mutations": {},
  });
  assert.equal((await guarded.GET({ nextUrl: { searchParams: new URLSearchParams() } } as unknown as Request)).status, 403);
});

test("the shared admin mutation select and PATCH response also carry the total", () => {
  assert.match(readFileSync("src/lib/admin-user-mutations.ts", "utf8"), /_count: \{ select: \{ brandMembers: true \} \}/);
  assert.match(readFileSync("src/app/api/admin/user-management/update-or-delete-users/[id]/route.ts", "utf8"), /brandMembershipCount: updated\._count\.brandMembers/);
});

test("memberships endpoint returns all seven memberships for admins only and 404s unknown users", async () => {
  const members = Array.from({ length: 7 }, (_, k) => ({ id: `m${k}`, role: k === 0 ? "ADMIN" : "VIEWER", brand: { id: `b${k}`, name: `Brand ${k}`, slug: `brand-${k}` } }));
  let reads = 0;
  const db = { user: { findUnique: async ({ where }: any) => { reads++; return where.id === "u0" ? { id: "u0", brandMembers: members } : null; } } };
  const route = (adminModule: object) => load("src/app/api/admin/users/[id]/memberships/route.ts", { "next/server": { NextResponse }, "@/lib/admin-auth": adminModule, "@/lib/prisma": { __esModule: true, default: db } });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const ok = await route(admin).GET(new Request("https://example.test"), ctx("u0"));
  assert.equal(ok.status, 200);
  const { data } = await ok.json();
  assert.equal(data.brandMembershipCount, 7);
  assert.equal(data.brands.length, 7);
  assert.deepEqual(data.brands[0], { id: "b0", name: "Brand 0", slug: "brand-0", membershipRole: "ADMIN" });
  assert.doesNotMatch(JSON.stringify(data), /email/);
  assert.equal((await route(admin).GET(new Request("https://example.test"), ctx("missing"))).status, 404);
  reads = 0;
  assert.equal((await route(notAdmin).GET(new Request("https://example.test"), ctx("u0"))).status, 403);
  assert.equal(reads, 0, "non-admins never reach the database");
});

test("admin pages show every connection and the membership total with an expand", () => {
  const brandsPage = readFileSync("src/app/(withSidebar)/dashboard/admin/brands/page.tsx", "utf8");
  assert.match(brandsPage, /brand\.connections \?\? \[\]\)\.map/);
  assert.match(brandsPage, /connection\.externalAccountLabel/);
  assert.match(brandsPage, /Commerce7/);
  const usersPage = readFileSync("src/app/(withSidebar)/admin/user-management/page.tsx", "utf8");
  assert.match(usersPage, /brandMembershipCount/);
  assert.match(usersPage, /Brands: \{total\}/);
  assert.match(usersPage, /\/api\/admin\/users\/\$\{encodeURIComponent\(user\.id\)\}\/memberships/);
});
