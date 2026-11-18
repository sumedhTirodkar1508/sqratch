import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildUrlFilterQuery, readUrlFilters } from "../src/hooks/use-url-filters";

const defaults = { status: "all", q: "", page: "1" };

test("URL filters read their defaults and only the managed keys", () => {
  assert.deepEqual(readUrlFilters(defaults, new URLSearchParams("")), defaults);
  assert.deepEqual(readUrlFilters(defaults, new URLSearchParams("status=NEW&page=3&unrelated=x")), { status: "NEW", q: "", page: "3" });
});

test("changing a filter keeps unrelated parameters, drops defaults and empty values", () => {
  // OAuth result flags and other deep-link parameters are never touched.
  const current = new URLSearchParams("shopify=connected&status=NEW&page=3");
  assert.equal(buildUrlFilterQuery(defaults, current, { page: "1" }), "shopify=connected&status=NEW");
  assert.equal(buildUrlFilterQuery(defaults, current, { status: "REDEEMED", q: "abc" }), "shopify=connected&status=REDEEMED&page=3&q=abc");
  assert.equal(buildUrlFilterQuery(defaults, new URLSearchParams("q=abc"), { q: "" }), "");
  // Keys that are not managed are ignored.
  assert.equal(buildUrlFilterQuery(defaults, new URLSearchParams(""), { other: "x" } as never), "");
});

test("dashboard routes stay untracked by third-party analytics so URL filters never leave the app", async () => {
  const { analyticsPath } = await import("../src/lib/analytics-policy");
  for (const path of ["/dashboard/brand/qr-batches", "/dashboard/brand/analytics", "/dashboard/creator/analytics"]) {
    assert.equal(analyticsPath(path), null, path);
  }
});

test("the QR inventory keeps filters in the URL but not the pasted code", () => {
  const page = readFileSync("src/app/(withSidebar)/dashboard/brand/qr-batches/page.tsx", "utf8");
  assert.match(page, /useUrlFilters\(/);
  assert.doesNotMatch(page, /codeSearch: ""/, "the code search must stay out of the URL");
  assert.match(page, /const \[codeSearch, setCodeSearch\] = useState/);
});
