import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url);

function source(relativePath: string) {
  return readFileSync(new URL(relativePath, root), "utf8");
}

describe("dashboard shell sidebar navigation", () => {
  const sidebar = source("src/components/app-sidebar.tsx");

  test("imports next/link for sidebar navigation", () => {
    assert.match(sidebar, /import Link from "next\/link";/);
  });

  test("sidebar items render next/link inside SidebarMenuButton asChild", () => {
    assert.match(sidebar, /<SidebarMenuButton\s+asChild/);
    assert.match(sidebar, /<Link\s+href=\{item\.url\}/);
    assert.match(sidebar, /<\/Link>/);
  });

  test("sidebar items no longer use plain anchors", () => {
    assert.doesNotMatch(sidebar, /<a\s/);
    assert.doesNotMatch(sidebar, /<\/a>/);
  });

  test("active state and aria-current are preserved on the link", () => {
    assert.match(sidebar, /isActive=\{isActive\}/);
    assert.match(sidebar, /aria-current=\{/);
    assert.match(sidebar, /pathname === item\.url \? "page" : "location"/);
  });
});

describe("dashboard segment boundaries", () => {
  test("loading.tsx and error.tsx exist at the dashboard segment root", () => {
    const base = "src/app/(withSidebar)/dashboard/";
    const loading = source(`${base}loading.tsx`);
    const error = source(`${base}error.tsx`);

    assert.match(loading, /export default function/);
    assert.match(error, /^"use client";/);
    assert.match(error, /reset: \(\) => void/);
    assert.match(error, /onClick=\{\(\) => reset\(\)\}/);
    assert.doesNotMatch(error, /error\.message/);
    assert.doesNotMatch(error, /error\.stack/);
  });
});
