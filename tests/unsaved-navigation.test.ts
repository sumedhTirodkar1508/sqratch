import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { internalNavigationTarget, type NavigationClick } from "../src/lib/unsaved-navigation";

const plain: NavigationClick = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
const here = { origin: "https://app.test", pathname: "/dashboard/brand/campaigns/c1/edit", search: "" };
const link = (href: string, extra: object = {}) => ({ href, target: null, hasDownload: false, ...extra });

test("an ordinary click on an internal link to another page is held", () => {
  assert.equal(internalNavigationTarget(plain, link("https://app.test/dashboard/brand/qr-batches?status=NEW#x"), here), "/dashboard/brand/qr-batches?status=NEW#x");
});

test("links that cannot discard the page, and modified clicks, pass through", () => {
  assert.equal(internalNavigationTarget(plain, null, here), null);
  assert.equal(internalNavigationTarget(plain, link("https://app.test/dashboard/brand/campaigns/c1/edit"), here), null, "same page");
  assert.equal(internalNavigationTarget(plain, link("https://app.test/dashboard/brand/campaigns/c1/edit#section"), here), null, "hash only");
  assert.equal(internalNavigationTarget(plain, link("https://elsewhere.test/x"), here), null, "external");
  assert.equal(internalNavigationTarget(plain, link("https://app.test/x", { target: "_blank" }), here), null, "new tab");
  assert.equal(internalNavigationTarget(plain, link("https://app.test/x", { hasDownload: true }), here), null, "download");
  for (const key of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) assert.equal(internalNavigationTarget({ ...plain, [key]: true }, link("https://app.test/x"), here), null, key);
  assert.equal(internalNavigationTarget({ ...plain, button: 1 }, link("https://app.test/x"), here), null, "middle click");
  assert.equal(internalNavigationTarget({ ...plain, defaultPrevented: true }, link("https://app.test/x"), here), null);
  assert.equal(internalNavigationTarget(plain, link("javascript:void(0)"), here), null);
  assert.equal(internalNavigationTarget(plain, link("https://app.test/api/brand/qr-batches/b1/export"), here), null, "API download links");
});

test("the guard is mounted for every dashboard page and asks through the shared dialog", () => {
  assert.match(readFileSync("src/app/(withSidebar)/layout.tsx", "utf8"), /<UnsavedNavigationGuard \/>/);
  const guard = readFileSync("src/components/unsaved-navigation-guard.tsx", "utf8");
  assert.match(guard, /addEventListener\("click", onClick, true\)/, "capture phase, before Next handles the click");
  assert.match(guard, /ConfirmDestructive/);
  assert.match(guard, /discardUnsavedChanges\(\);\s*if \(target\) router\.push\(target\)/, "discard only on confirm, then navigate");
  assert.match(guard, /Cancel to stay and keep what you entered/);
});

test("campaign, lesson, post and reward forms register their unsaved state", () => {
  for (const file of [
    "src/components/brand/campaign-form.tsx",
    "src/app/(withSidebar)/dashboard/creator/courses/[id]/lessons/page.tsx",
    "src/components/rewards/commerce7-brand-rewards.tsx",
    "src/app/(withSidebar)/dashboard/brand/rewards/page.tsx",
  ]) {
    let source = "";
    try { source = readFileSync(file, "utf8"); } catch { /* path checked below */ }
    assert.ok(source, `${file} exists`);
    assert.match(source, /useUnsavedChanges\(/, file);
  }
});
