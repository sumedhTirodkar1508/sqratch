process.env.APP_ENCRYPTION_KEY ||= "dummy-encryption-key-at-least-32-chars-long";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realDbTest } from "./helpers/real-db";

const { skipReason } = realDbTest("REPORT_SCOPE_REAL_DB");
const at = (iso: string) => new Date(iso);

test("order explorer: date range follows the chosen basis, tenant scope and keyset paging hold", { skip: skipReason }, async () => {
  const { default: prisma } = await import("../src/lib/prisma");
  const { brandCommerceOrdersGetImpl } = await import("../src/app/api/brand/commerce/orders/route");
  const key = randomUUID().slice(0, 8);
  const brand = await prisma.brand.create({ data: { name: key, slug: key } });
  const other = await prisma.brand.create({ data: { name: `${key}-o`, slug: `${key}-o` } });
  const connection = await prisma.commerceConnection.create({ data: { brandId: brand.id, provider: "SHOPIFY", status: "CONNECTED", displayName: "S", externalAccountId: `${key}.myshopify.com` } });
  const otherConnection = await prisma.commerceConnection.create({ data: { brandId: other.id, provider: "SHOPIFY", status: "CONNECTED", displayName: "S", externalAccountId: `${key}-o.myshopify.com` } });
  const make = (brandId: string, connectionId: string, name: string, providerCreatedAt: Date | null, createdAt: Date) =>
    prisma.commerceOrder.create({
      data: { connectionId, brandId, provider: "SHOPIFY", externalOrderId: `${key}-${name}`, orderNumber: name, providerCreatedAt, createdAt, currencyCode: "USD", totalMinor: BigInt(100), financialStatus: "PAID" },
    });
  try {
    await make(brand.id, connection.id, "delayed", at("2026-10-30T12:00:00Z"), at("2026-11-02T08:00:00Z"));
    await make(brand.id, connection.id, "no-store-date", null, at("2026-10-15T09:00:00Z"));
    await make(brand.id, connection.id, "september", at("2026-09-28T10:00:00Z"), at("2026-10-03T10:00:00Z"));
    await make(brand.id, connection.id, "november", at("2026-11-05T10:00:00Z"), at("2026-11-06T10:00:00Z"));
    await make(other.id, otherConnection.id, "other-brand", at("2026-10-10T10:00:00Z"), at("2026-10-10T10:00:00Z"));

    const context = async () => ({ userId: "u", selectionRequired: false, brands: [], membership: { id: "m", role: "ADMIN", brand: { id: brand.id, name: "B", slug: key } } }) as never;
    const list = async (query: Record<string, string>) => {
      const response = await brandCommerceOrdersGetImpl({ getContext: context }, { limit: "50", ...query });
      assert.equal(response.status, 200);
      return (await response.json()) as { data: Array<{ orderNumber: string }>; meta: { hasNextPage: boolean; nextCursor: string | null; dateBasis: string } };
    };
    const names = (result: { data: Array<{ orderNumber: string }> }) => result.data.map((row) => row.orderNumber).sort();
    const october = { dateFrom: "2026-10-01T00:00:00.000Z", dateTo: "2026-10-31T23:59:59.999Z" };

    const provider = await list({ ...october, dateBasis: "provider" });
    assert.deepEqual(names(provider), ["delayed", "no-store-date"], "a null store date falls back to the receipt date");
    assert.equal(provider.meta.dateBasis, "provider");
    assert.deepEqual(names(await list(october)), ["delayed", "no-store-date"], "provider is the default");

    const ingested = await list({ ...october, dateBasis: "ingested" });
    assert.deepEqual(names(ingested), ["no-store-date", "september"]);
    assert.equal(ingested.meta.dateBasis, "ingested");

    const all = await list({ dateBasis: "ingested" });
    assert.deepEqual(names(all), ["delayed", "no-store-date", "november", "september"], "no range, and the other brand never appears");

    // Keyset paging stays stable inside a date-filtered result.
    const first = await list({ ...october, dateBasis: "ingested", limit: "1" });
    assert.equal(first.data.length, 1);
    assert.equal(first.meta.hasNextPage, true);
    const second = await list({ ...october, dateBasis: "ingested", limit: "1", cursor: first.meta.nextCursor! });
    assert.deepEqual([first.data[0].orderNumber, second.data[0].orderNumber].sort(), ["no-store-date", "september"]);
    assert.equal(second.meta.hasNextPage, false);
  } finally {
    await prisma.commerceOrder.deleteMany({ where: { brandId: { in: [brand.id, other.id] } } });
    await prisma.commerceConnection.deleteMany({ where: { brandId: { in: [brand.id, other.id] } } });
    await prisma.brand.deleteMany({ where: { id: { in: [brand.id, other.id] } } });
  }
});
