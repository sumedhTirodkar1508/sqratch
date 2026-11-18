/**
 * P39 — scope, attribution and drilldown consistency.
 *
 * ReportMeta contents per route, the "not filtered by campaign" caption logic,
 * labels, drilldown URL building and the explorer's date-basis predicate. No
 * database: Prisma model methods are replaced with in-memory doubles.
 */
import "./env-setup";
process.env.DIRECT_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.NEXTAUTH_SECRET = "test-nextauth-secret";
process.env.APP_ENCRYPTION_KEY = "dummy-encryption-key-at-least-32-chars-long";

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

import {
  buildReportMeta,
  campaignFilterNotApplied,
  CAMPAIGN_NOT_APPLIED_NOTE,
  describeReportScope,
  ORDER_PAYMENT_STATUSES,
  parseReportMeta,
  requestedFilterNames,
  type ReportMeta,
} from "../src/lib/report-meta";
import {
  ATTRIBUTION_NOTE,
  CONVERSION_LIMITATIONS_NOTE,
  ENTRY_CAMPAIGN_BREAKDOWN_TITLE,
  PRODUCT_BREAKDOWN_NOTE,
  PRODUCT_CAMPAIGN_BREAKDOWN_TITLE,
} from "../src/lib/commerce/analytics-labels";
import {
  buildOrderExplorerHref,
  instantToDateTimeLocalValue,
  orderExplorerDateBasisCaption,
  parseOrderDrilldownPeriod,
} from "../src/lib/commerce/order-drilldown";
import { buildOrderDateWhere } from "../src/lib/commerce/order-list";
import { orderDateWhere } from "../src/lib/commerce/order-date-basis";
import { buildConversionAnalytics, buildConversionDailyTrend } from "../src/lib/commerce/order-analytics";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const NOW = new Date("2026-11-17T10:00:00.000Z");

/* ------------------------------------------------------------------ builder */

describe("ReportMeta builder and parser", () => {
  test("states period, UTC, basis, scope, filters, statuses, generation time and coverage", () => {
    const meta = buildReportMeta({
      period: { start: new Date("2026-11-01T00:00:00.000Z"), end: new Date("2026-11-30T23:59:59.999Z") },
      dateBasis: "provider",
      scope: "whole brand",
      unsupportedFilters: ["campaignId"],
      includedStatuses: ORDER_PAYMENT_STATUSES,
      coverage: { currencies: ["CAD", "USD"], fallbackOrderCount: 2 },
      now: NOW,
    });
    assert.deepEqual(meta.period, { start: "2026-11-01T00:00:00.000Z", end: "2026-11-30T23:59:59.999Z", timezone: "UTC" });
    assert.equal(meta.dateBasis, "provider");
    assert.equal(meta.scope, "whole brand");
    assert.deepEqual(meta.appliedFilters, {});
    assert.deepEqual(meta.unsupportedFilters, ["campaignId"]);
    assert.ok(meta.includedStatuses.includes("PENDING") && meta.includedStatuses.includes("VOIDED"));
    assert.equal(meta.generatedAt, NOW.toISOString());
    assert.deepEqual(meta.coverage, { currencies: ["CAD", "USD"], fallbackOrderCount: 2 });
    assert.deepEqual(parseReportMeta(JSON.parse(JSON.stringify(meta))), meta);
  });

  test("an open period end stays null instead of being invented", () => {
    const meta = buildReportMeta({ period: { start: null, end: null }, dateBasis: "event", scope: "whole brand", now: NOW });
    assert.deepEqual(meta.period, { start: null, end: null, timezone: "UTC" });
    assert.match(describeReportScope(meta), /^All dates \(UTC\)/);
  });

  test("a malformed meta parses to null so a page shows no caption rather than a wrong one", () => {
    const good = buildReportMeta({ period: { start: NOW, end: NOW }, dateBasis: "event", scope: "creator", now: NOW });
    assert.equal(parseReportMeta(undefined), null);
    assert.equal(parseReportMeta({ ...good, dateBasis: "payment" }), null);
    assert.equal(parseReportMeta({ ...good, scope: "everyone" }), null);
    assert.equal(parseReportMeta({ ...good, period: { ...good.period, timezone: "Europe/Paris" } }), null);
    assert.equal(parseReportMeta({ ...good, appliedFilters: { campaignId: 3 } }), null);
    assert.equal(parseReportMeta({ ...good, coverage: { currencies: [1] } }), null);
  });

  test("requestedFilterNames lists only the named filters actually sent", () => {
    const params = new URLSearchParams("campaignId=abc&experienceId=&dateFrom=2026-11-01");
    assert.deepEqual(requestedFilterNames(params, ["campaignId", "experienceId"]), ["campaignId"]);
  });
});

/* --------------------------------------------------------- caption logic */

describe("scope caption", () => {
  const conversionMeta: ReportMeta = buildReportMeta({
    period: { start: new Date("2026-11-01T00:00:00.000Z"), end: new Date("2026-11-30T23:59:59.999Z") },
    dateBasis: "provider",
    scope: "whole brand",
    includedStatuses: ORDER_PAYMENT_STATUSES,
    coverage: { currencies: ["CAD", "USD"] },
    now: NOW,
  });

  test("names period, timezone, basis, scope, statuses and currencies", () => {
    const caption = describeReportScope(conversionMeta);
    assert.match(caption, /2026-11-01 to 2026-11-30 \(UTC\)/);
    assert.match(caption, /order date the store recorded/);
    assert.match(caption, /Whole brand/);
    assert.match(caption, /counts every payment status/);
    assert.match(caption, /currencies CAD, USD, never added together/);
    assert.doesNotMatch(caption, /revenue|commission|captured/i);
  });

  test("a campaign filter that the report did not apply is called out, never implied", () => {
    assert.equal(campaignFilterNotApplied(conversionMeta, "campaign-1"), true);
    assert.match(describeReportScope(conversionMeta, { campaignFilterId: "campaign-1" }), new RegExp(CAMPAIGN_NOT_APPLIED_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(CAMPAIGN_NOT_APPLIED_NOTE, "Not filtered by campaign: shows the whole brand.");
  });

  test("no notice with no campaign filter, and none when the report applied it", () => {
    assert.equal(campaignFilterNotApplied(conversionMeta, ""), false);
    assert.equal(campaignFilterNotApplied(conversionMeta, null), false);
    assert.doesNotMatch(describeReportScope(conversionMeta), /Not filtered by campaign/);
    const engagement = buildReportMeta({
      period: { start: NOW, end: NOW },
      dateBasis: "event",
      scope: "campaign",
      appliedFilters: { campaignId: "campaign-1" },
      now: NOW,
    });
    assert.equal(campaignFilterNotApplied(engagement, "campaign-1"), false);
    assert.doesNotMatch(describeReportScope(engagement, { campaignFilterId: "campaign-1" }), /Not filtered by campaign/);
    assert.match(describeReportScope(engagement), /Selected campaign/);
  });
});

/* ------------------------------------------------------------------- labels */

describe("labels", () => {
  test("campaign breakdowns and the product breakdown say what they count", () => {
    assert.equal(ENTRY_CAMPAIGN_BREAKDOWN_TITLE, "By entry campaign (how the visitor arrived)");
    assert.equal(PRODUCT_CAMPAIGN_BREAKDOWN_TITLE, "By product campaign (which campaign promoted the product)");
    assert.equal(
      PRODUCT_BREAKDOWN_NOTE,
      "Orders containing this product. An order with several products is counted once for each, so rows do not add up to total orders.",
    );
    assert.equal(
      ATTRIBUTION_NOTE,
      "Attributed orders followed a tracked SQRATCH link. Attribution does not show that SQRATCH caused the sale and is not a commission statement.",
    );
    assert.match(CONVERSION_LIMITATIONS_NOTE, /not collected payments/);
  });

  test("both pages use the shared labels, the caption and the attribution sentence", () => {
    const brand = read("src/app/(withSidebar)/dashboard/brand/analytics/page.tsx");
    for (const name of ["ENTRY_CAMPAIGN_BREAKDOWN_TITLE", "PRODUCT_CAMPAIGN_BREAKDOWN_TITLE", "PRODUCT_BREAKDOWN_NOTE"]) {
      assert.match(brand, new RegExp(`\\{${name}\\}`), name);
    }
    assert.match(brand, /<ReportScopeCaption meta=\{data\.meta\} campaignFilterId=\{campaignFilterId\}/);
    assert.match(brand, /<ReportScopeCaption meta=\{parseReportMeta\(data\.meta\)\} campaignFilterId=\{campaignFilterId\}/);
    assert.match(brand, /<AttributionNote \/>/);
    const creator = read("src/app/(withSidebar)/dashboard/creator/analytics/page.tsx");
    assert.match(creator, /<AttributionNote \/>/);
    assert.match(creator, /<ReportScopeCaption meta=\{data\.meta\} \/>/);
    for (const path of ["src/lib/commerce/analytics-labels.ts", "src/components/commerce/report-scope-caption.tsx", "src/lib/report-meta.ts"]) {
      const code = read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      assert.doesNotMatch(code, /revenue|captured payment/i, path);
    }
  });

  test("the creator page names no campaign dimension", () => {
    const creator = read("src/app/(withSidebar)/dashboard/creator/analytics/page.tsx");
    assert.doesNotMatch(creator, /campaignId/);
  });
});

/* ---------------------------------------------------------------- drilldown */

describe("drilldown links", () => {
  const range = { start: "2026-11-01T00:00:00.000Z", end: "2026-11-30T23:59:59.999Z" };

  test("carry the period, the date basis and the attribution filter", () => {
    const href = new URL(buildOrderExplorerHref({ range, dateBasis: "ingested", attributed: "attributed" }), "http://localhost");
    assert.equal(href.pathname, "/dashboard/brand/commerce/orders");
    assert.equal(href.searchParams.get("attributed"), "attributed");
    assert.equal(href.searchParams.get("dateFrom"), range.start);
    assert.equal(href.searchParams.get("dateTo"), range.end);
    assert.equal(href.searchParams.get("dateBasis"), "ingested");
  });

  test("an unfiltered drilldown still carries period and basis but no attribution filter", () => {
    const href = new URL(buildOrderExplorerHref({ range, dateBasis: "provider" }), "http://localhost");
    assert.equal(href.searchParams.get("attributed"), null);
    assert.equal(href.searchParams.get("dateBasis"), "provider");
  });

  test("a malformed bound is dropped, never guessed", () => {
    const href = new URL(buildOrderExplorerHref({ range: { start: "nope", end: range.end }, dateBasis: "provider" }), "http://localhost");
    assert.equal(href.searchParams.get("dateFrom"), null);
    assert.equal(href.searchParams.get("dateTo"), range.end);
  });

  test("the explorer reads back the same period and basis, and ignores invalid ones", () => {
    const parsed = parseOrderDrilldownPeriod(new URL(buildOrderExplorerHref({ range, dateBasis: "ingested" }), "http://localhost").searchParams);
    assert.deepEqual(parsed, { dateFrom: range.start, dateTo: range.end, dateBasis: "ingested" });
    assert.deepEqual(parseOrderDrilldownPeriod(new URLSearchParams("dateFrom=x&dateTo=y&dateBasis=payment")), {});
    assert.deepEqual(parseOrderDrilldownPeriod(new URLSearchParams(`dateFrom=${range.end}&dateTo=${range.start}`)), {}, "an inverted range is dropped");
  });

  test("the date-time-local value round-trips to the same instant, milliseconds included", () => {
    for (const iso of [range.start, range.end, "2026-03-29T01:30:00.123Z"]) {
      assert.equal(new Date(instantToDateTimeLocalValue(iso)).toISOString(), iso);
    }
  });

  test("the explorer states which date its filter uses", () => {
    assert.match(orderExplorerDateBasisCaption("provider"), /order date the store recorded/);
    assert.match(orderExplorerDateBasisCaption("ingested"), /date SQRATCH received the order/);
    const client = read("src/app/(withSidebar)/dashboard/brand/commerce/orders/BrandCommerceOrdersClient.tsx");
    assert.match(client, /orderExplorerDateBasisCaption\(/);
    assert.match(client, /params\.set\("dateBasis", filters\.dateBasis\)/);
  });
});

/* ------------------------------------------------- explorer date predicate */

type Fixture = { id: string; providerCreatedAt: Date | null; createdAt: Date };
const at = (iso: string) => new Date(iso);

/** Evaluates the Prisma-shaped predicate the explorer builds, against plain fixtures. */
function matches(where: Record<string, unknown>, row: Fixture): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") return (value as Array<Record<string, unknown>>).some((w) => matches(w, row));
    if (key === "AND") return (value as Array<Record<string, unknown>>).every((w) => matches(w, row));
    const field = row[key as keyof Fixture] as Date | null;
    if (value === null) return field === null;
    const range = value as { gte?: Date; lte?: Date };
    if (field === null) return false;
    return (!range.gte || field >= range.gte) && (!range.lte || field <= range.lte);
  });
}

describe("order explorer date range and basis", () => {
  const rows: Fixture[] = [
    { id: "delayed", providerCreatedAt: at("2026-10-30T12:00:00Z"), createdAt: at("2026-11-02T08:00:00Z") },
    { id: "no-store-date", providerCreatedAt: null, createdAt: at("2026-10-15T09:00:00Z") },
    { id: "september", providerCreatedAt: at("2026-09-28T10:00:00Z"), createdAt: at("2026-10-03T10:00:00Z") },
    { id: "november", providerCreatedAt: at("2026-11-05T10:00:00Z"), createdAt: at("2026-11-06T10:00:00Z") },
  ];
  const october = { from: at("2026-10-01T00:00:00.000Z"), to: at("2026-10-31T23:59:59.999Z") };
  const ids = (basis: "provider" | "ingested", from = october.from, to = october.to) =>
    rows.filter((row) => matches(buildOrderDateWhere(from, to, basis) as Record<string, unknown>, row)).map((row) => row.id);

  test("provider basis uses the store date, and an order with no store date falls back to receipt date", () => {
    assert.deepEqual(ids("provider"), ["delayed", "no-store-date"]);
  });

  test("ingested basis uses the receipt date only, so a null store date never matters", () => {
    assert.deepEqual(ids("ingested"), ["no-store-date", "september"]);
  });

  test("the default basis is the store date, unchanged from before", () => {
    assert.deepEqual(buildOrderDateWhere(october.from, october.to), buildOrderDateWhere(october.from, october.to, "provider"));
  });

  test("matches the conversion report's own predicate exactly, so a drilldown lists what the report counted", () => {
    for (const basis of ["provider", "ingested"] as const) {
      const report = orderDateWhere(basis, { start: october.from, end: october.to }) as Record<string, unknown>;
      const explorer = buildOrderDateWhere(october.from, october.to, basis) as Record<string, unknown>;
      const same = (where: Record<string, unknown>) => rows.filter((row) => matches(where, row)).map((row) => row.id);
      assert.deepEqual(same(explorer), same(report), basis);
    }
  });

  test("open-ended ranges and no range", () => {
    assert.deepEqual(buildOrderDateWhere(null, null, "ingested"), {});
    assert.deepEqual(ids("ingested", october.from, null as never), ["delayed", "no-store-date", "september", "november"]);
  });

  test("keyset ordering and tenant filters are untouched", () => {
    const route = read("src/app/api/brand/commerce/orders/route.ts");
    assert.match(route, /orderBy: \[\{ createdAt: "desc" \}, \{ id: "desc" \}\]/);
    assert.match(route, /where: buildOrderListWhere\(input\)/);
    assert.match(route, /const brandId = context\.membership\.brand\.id/);
    assert.match(route, /INVALID_DATE_BASIS/);
  });

  test("the orders route rejects an unknown dateBasis with a 400", async () => {
    const { brandCommerceOrdersGetImpl } = await import("../src/app/api/brand/commerce/orders/route");
    const context = { membership: { brand: { id: "brand-1" } } } as never;
    const bad = await brandCommerceOrdersGetImpl({ getContext: async () => context }, { dateBasis: "payment" });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, "INVALID_DATE_BASIS");

    let seen: unknown = null;
    const ok = await brandCommerceOrdersGetImpl(
      { getContext: async () => context, findOrders: async (input) => { seen = input; return []; } },
      { dateFrom: "2026-10-01T00:00:00.000Z", dateTo: "2026-10-31T23:59:59.999Z", dateBasis: "ingested" },
    );
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).meta.dateBasis, "ingested");
    assert.deepEqual((seen as { dateWhere: unknown }).dateWhere, buildOrderDateWhere(october.from, october.to, "ingested"));
    assert.equal((seen as { brandId: string }).brandId, "brand-1");
  });
});

/* ------------------------------------------------------ removed aliases */

describe("removed deprecated aliases", () => {
  const order = {
    provider: "SHOPIFY" as const, financialStatus: "PAID" as const, currencyCode: "USD", totalMinor: BigInt(1000),
    totalRefundedMinor: BigInt(0), netRevenueMinor: BigInt(1000), lineItems: [],
    attribution: { entryCampaignId: null, productCampaignId: null, experienceId: "e1", creatorProfileId: "c1", lessonId: null, connectedProductId: null },
  };

  test("neither the headline nor a trend point carries a removed alias", () => {
    const headline = buildConversionAnalytics([order]);
    const trend = buildConversionDailyTrend([{ ...order, orderDate: NOW }], { start: NOW, end: NOW }, 400);
    for (const alias of ["grossAttributedRevenueByCurrency", "refundedRevenueByCurrency", "netAttributedRevenueByCurrency"]) {
      assert.ok(!(alias in headline), alias);
    }
    for (const alias of ["grossRevenueByCurrency", "refundedRevenueByCurrency", "netRevenueByCurrency"]) {
      assert.ok(!(alias in trend[0]), alias);
    }
    assert.ok("attributedOrderValueByCurrency" in headline && "attributedOrderValueByCurrency" in trend[0]);
  });

  test("no source file reads or writes a removed alias", () => {
    for (const path of [
      "src/lib/commerce/order-analytics.ts",
      "src/lib/commerce/conversion-analytics-client.ts",
      "src/app/api/brand/analytics/conversions/route.ts",
      "src/app/api/creator/analytics/conversions/route.ts",
      "src/app/(withSidebar)/dashboard/brand/analytics/page.tsx",
      "src/app/(withSidebar)/dashboard/creator/analytics/page.tsx",
    ]) {
      assert.doesNotMatch(read(path), /grossAttributedRevenueByCurrency|grossRevenueByCurrency|\brefundedRevenueByCurrency|netAttributedRevenueByCurrency|\bnetRevenueByCurrency/, path);
    }
  });
});

/* ------------------------------------------------------ route-level meta */

describe("ReportMeta on each route", () => {
  // Model delegates are replaced with in-memory doubles and put back after each test.
  const originals: Array<() => void> = [];
  afterEach(() => {
    while (originals.length) originals.pop()!();
  });
  async function stub(model: string, methods: Record<string, unknown>) {
    const client = (await import("../src/lib/prisma")).default as unknown as Record<string, unknown>;
    const original = client[model];
    client[model] = methods;
    originals.push(() => { client[model] = original; });
  }

  const brandContext = async () =>
    ({ userId: "u1", selectionRequired: false, brands: [], membership: { id: "m", role: "ADMIN", brand: { id: "brand-1", name: "B", slug: "b" } } }) as never;
  const creatorContext = async () => ({ userId: "u1", creatorProfile: { id: "creator-1" } }) as never;

  function orderRow(overrides: Record<string, unknown> = {}) {
    return {
      provider: "SHOPIFY", financialStatus: "PAID", currencyCode: "CAD", totalMinor: BigInt(5000), totalRefundedMinor: BigInt(0),
      netRevenueMinor: BigInt(5000), cancelledAt: null, createdAt: at("2026-11-02T00:00:00Z"), providerCreatedAt: null,
      attribution: { experienceId: "e1", creatorProfileId: "creator-1", lessonId: null, connectedProductId: null, entryCampaign: null, productCampaign: null },
      lineItems: [],
      ...overrides,
    };
  }

  test("brand engagement: whole brand, then campaign when filtered; period is the requested UTC range", async () => {
    await stub("campaign", { findMany: async () => [] });
    const { brandAnalyticsGetImpl } = await import("../src/app/api/brand/analytics/route");

    const all = await brandAnalyticsGetImpl(new NextRequest("http://localhost/api/brand/analytics?dateFrom=2026-11-01&dateTo=2026-11-30"), brandContext);
    const allMeta = parseReportMeta((await all.json()).data.meta);
    assert.ok(allMeta);
    assert.equal(allMeta.scope, "whole brand");
    assert.equal(allMeta.dateBasis, "event");
    assert.deepEqual(allMeta.period, { start: "2026-11-01T00:00:00.000Z", end: "2026-11-30T23:59:59.999Z", timezone: "UTC" });
    assert.deepEqual(allMeta.appliedFilters, {});

    const one = await brandAnalyticsGetImpl(new NextRequest("http://localhost/api/brand/analytics?campaignId=camp-1&dateFrom=2026-11-01&dateTo=2026-11-30"), brandContext);
    const oneMeta = parseReportMeta((await one.json()).data.meta);
    assert.equal(oneMeta?.scope, "campaign");
    assert.deepEqual(oneMeta?.appliedFilters, { campaignId: "camp-1" });
    assert.equal(campaignFilterNotApplied(oneMeta!, "camp-1"), false);
  });

  test("brand conversions: whole brand, basis, statuses, currencies, fallback count, and campaign reported as unsupported", async () => {
    await stub("commerceOrder", {
      findMany: async () => [orderRow(), orderRow({ currencyCode: "USD", providerCreatedAt: at("2026-11-03T00:00:00Z") })],
    });
    for (const model of ["experience", "creatorProfile", "connectedCommerceProduct", "campaign", "lesson"]) {
      await stub(model, { findMany: async () => [] });
    }
    const { brandConversionsGetImpl } = await import("../src/app/api/brand/analytics/conversions/route");
    const response = await brandConversionsGetImpl(
      new NextRequest("http://localhost/api/brand/analytics/conversions?dateFrom=2026-11-01&dateTo=2026-11-30&dateBasis=ingested&campaignId=camp-1"),
      brandContext,
    );
    const data = (await response.json()).data;
    const meta = parseReportMeta(data.meta);
    assert.ok(meta);
    assert.equal(meta.scope, "whole brand");
    assert.equal(meta.dateBasis, "ingested");
    assert.deepEqual(meta.unsupportedFilters, ["campaignId"]);
    assert.deepEqual(meta.includedStatuses, [...ORDER_PAYMENT_STATUSES]);
    assert.deepEqual(meta.coverage.currencies, ["CAD", "USD"]);
    assert.equal(meta.coverage.fallbackOrderCount, 0);
    assert.equal(campaignFilterNotApplied(meta, "camp-1"), true);
    // Additive: every existing key is still there, and the aliases are not.
    for (const key of ["range", "dateBasis", "fallbackOrderCount", "attributedOrderValueByCurrency", "refundedAttributedValueByCurrency", "currentNetAttributedOrderValueByCurrency", "dailyTrend"]) {
      assert.ok(key in data, key);
    }
    for (const alias of ["grossAttributedRevenueByCurrency", "refundedRevenueByCurrency", "netAttributedRevenueByCurrency"]) {
      assert.ok(!(alias in data), alias);
    }
    assert.ok(!("grossRevenueByCurrency" in data.dailyTrend[0]));
    assert.equal(data.range.start, "2026-11-01T00:00:00.000Z");
  });

  test("brand conversions on the provider basis report the fallback count", async () => {
    await stub("commerceOrder", {
      findMany: async () => [orderRow({ attribution: null }), orderRow({ providerCreatedAt: at("2026-11-03T00:00:00Z"), attribution: null })],
    });
    const { brandConversionsGetImpl } = await import("../src/app/api/brand/analytics/conversions/route");
    const response = await brandConversionsGetImpl(new NextRequest("http://localhost/api/brand/analytics/conversions?dateFrom=2026-11-01&dateTo=2026-11-30"), brandContext);
    const meta = parseReportMeta((await response.json()).data.meta);
    assert.equal(meta?.dateBasis, "provider");
    assert.equal(meta?.coverage.fallbackOrderCount, 1);
    assert.deepEqual(meta?.coverage.currencies, []);
  });

  test("creator conversions: creator scope, no campaign information, no removed aliases", async () => {
    await stub("commerceOrder", {
      findMany: async () => [
        { ...orderRow(), attribution: { experienceId: "e1", creatorProfileId: "creator-1", lessonId: null, connectedProductId: null } },
      ],
    });
    for (const model of ["experience", "lesson", "brandCommerceProduct", "connectedCommerceProduct"]) {
      await stub(model, { findMany: async () => [] });
    }
    const { creatorConversionsGetImpl } = await import("../src/app/api/creator/analytics/conversions/route");
    const response = await creatorConversionsGetImpl(new NextRequest("http://localhost/api/creator/analytics/conversions?dateFrom=2026-11-01&dateTo=2026-11-30"), creatorContext);
    const data = (await response.json()).data;
    const meta = parseReportMeta(data.meta);
    assert.ok(meta);
    assert.equal(meta.scope, "creator");
    assert.deepEqual(meta.appliedFilters, {});
    assert.deepEqual(meta.coverage.currencies, ["CAD"]);
    assert.doesNotMatch(JSON.stringify(data.meta), /campaign/i, "a creator never receives a campaign dimension");
    for (const alias of ["grossAttributedRevenueByCurrency", "refundedRevenueByCurrency", "netAttributedRevenueByCurrency"]) {
      assert.ok(!(alias in data), alias);
    }
  });

  test("creator engagement: creator scope, or experience scope with the applied filter", async () => {
    await stub("experience", { findMany: async () => [] });
    const { creatorAnalyticsGetImpl } = await import("../src/app/api/creator/analytics/route");
    const all = await creatorAnalyticsGetImpl(new NextRequest("http://localhost/api/creator/analytics?dateFrom=2026-11-01&dateTo=2026-11-30"), creatorContext);
    const allData = (await all.json()).data;
    const allMeta = parseReportMeta(allData.meta);
    assert.equal(allMeta?.scope, "creator");
    assert.equal(allMeta?.dateBasis, "event");
    assert.deepEqual(allMeta?.period, { start: "2026-11-01T00:00:00.000Z", end: "2026-11-30T23:59:59.999Z", timezone: "UTC" });
    assert.ok("lessonsCompletedInPeriod" in allData.totals, "existing P37 keys are kept");

    const one = await creatorAnalyticsGetImpl(new NextRequest("http://localhost/api/creator/analytics?experienceId=e1&dateFrom=2026-11-01&dateTo=2026-11-30"), creatorContext);
    const oneMeta = parseReportMeta((await one.json()).data.meta);
    assert.equal(oneMeta?.scope, "experience");
    assert.deepEqual(oneMeta?.appliedFilters, { experienceId: "e1" });
  });

  const emptyRepository = new Proxy({}, {
    get: (_target, name) => async () => {
      if (name === "countClicks") return 0;
      if (String(name).startsWith("countDistinct")) return { value: 0, truncated: false };
      if (name === "listClickTimestamps") return { timestamps: [], truncated: false };
      return [];
    },
  }) as never;

  test("brand click panel: whole brand on the event basis, campaign reported unsupported", async () => {
    const { brandCommerceAnalyticsGetImpl } = await import("../src/app/api/brand/analytics/commerce/route");
    const response = await brandCommerceAnalyticsGetImpl(new NextRequest("http://localhost/api/brand/analytics/commerce?campaignId=camp-1"), {
      getBrandContext: brandContext, repository: emptyRepository, now: () => NOW,
    });
    const data = (await response.json()).data;
    const meta = parseReportMeta(data.meta);
    assert.equal(meta?.scope, "whole brand");
    assert.equal(meta?.dateBasis, "event");
    assert.deepEqual(meta?.unsupportedFilters, ["campaignId"]);
    assert.equal(meta?.generatedAt, NOW.toISOString());
    assert.equal(campaignFilterNotApplied(meta!, "camp-1"), true);
    assert.ok("range" in data && "totals" in data);
  });

  test("creator click panel: creator scope, and experience scope with its filter, in both normal and empty responses", async () => {
    const { creatorCommerceAnalyticsGetImpl } = await import("../src/app/api/creator/analytics/commerce/route");
    const deps = {
      getCreatorContext: creatorContext, repository: emptyRepository, now: () => NOW,
      listOwnedExperiences: async () => [{ id: "e1", title: "E1" }],
      listLessonTitles: async () => [], listProductTitles: async () => [],
    };
    const all = await creatorCommerceAnalyticsGetImpl(new NextRequest("http://localhost/api/creator/analytics/commerce"), deps as never);
    assert.equal(parseReportMeta((await all.json()).data.meta)?.scope, "creator");
    const one = await creatorCommerceAnalyticsGetImpl(new NextRequest("http://localhost/api/creator/analytics/commerce?experienceId=e1"), deps as never);
    const oneMeta = parseReportMeta((await one.json()).data.meta);
    assert.equal(oneMeta?.scope, "experience");
    assert.deepEqual(oneMeta?.appliedFilters, { experienceId: "e1" });
    const none = await creatorCommerceAnalyticsGetImpl(new NextRequest("http://localhost/api/creator/analytics/commerce"), { ...deps, listOwnedExperiences: async () => [] } as never);
    assert.equal(parseReportMeta((await none.json()).data.meta)?.scope, "creator", "the zero state carries meta too");
  });
});
