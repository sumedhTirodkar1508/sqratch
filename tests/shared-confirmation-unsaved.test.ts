import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import { createDirtyRegistry } from "../src/hooks/use-unsaved-changes";

type Node = { type: unknown; props: Record<string, unknown> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
function content(value: unknown): string {
  if (Array.isArray(value)) return value.map(content).join("");
  if (!value || typeof value !== "object") return value == null || value === false ? "" : String(value);
  return content((value as Node).props?.children);
}
function load(path: string, require: (name: string) => unknown, globals: object = {}) {
  const exports: Record<string, unknown> = {};
  const source = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(source, { exports, require, Error, String, Boolean, URLSearchParams, ...globals });
  return exports;
}
function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/.test(path) ? [path] : [];
  });
}

test("no native confirm remains in dashboard pages or shared components", () => {
  const files = [...walk("src/app/(withSidebar)"), ...walk("src/components")];
  const offenders = files.filter((file) => /\bwindow\.confirm\s*\(|(^|[^.\w])confirm\s*\(/m.test(readFileSync(file, "utf8")));
  assert.deepEqual(offenders, []);
});

test("destructive dashboard actions go through ConfirmDestructive", () => {
  for (const [file, label] of [
    ["src/app/(withSidebar)/dashboard/creator/experiences/[id]/courses/page.tsx", "Delete course"],
    ["src/app/(withSidebar)/dashboard/creator/courses/[id]/lessons/page.tsx", "Delete lesson"],
    ["src/app/(withSidebar)/dashboard/brand/commerce/BrandCommerceClient.tsx", "Disconnect Commerce7"],
    ["src/app/(withSidebar)/dashboard/brand/shopify/BrandShopifyClient.tsx", "Disconnect Shopify"],
    ["src/app/(withSidebar)/dashboard/brand/rewards/page.tsx", "Disable offer"],
    ["src/components/experience/posts-client.tsx", "Delete comment"],
    ["src/components/rewards/commerce7-brand-rewards.tsx", "Revoke coupon"],
  ]) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /<ConfirmDestructive/, file);
    assert.ok(source.includes(`confirmLabel="${label}"`), `${file} confirm label ${label}`);
  }
  const courses = readFileSync("src/app/(withSidebar)/dashboard/creator/experiences/[id]/courses/page.tsx", "utf8");
  assert.match(courses, /deletes every lesson in this course and their uploaded videos/);
});

test("dirty registry tracks, notifies, clears and never reports dirty when nothing registered", () => {
  const registry = createDirtyRegistry();
  let notified = 0;
  const unsubscribe = registry.subscribe(() => notified++);
  assert.equal(registry.isDirty(), false);
  registry.set("a", false);
  assert.equal(registry.isDirty(), false);
  assert.equal(notified, 0, "no-op writes do not notify");
  registry.set("a", true);
  registry.set("b", true);
  assert.equal(registry.isDirty(), true);
  registry.set("a", false);
  assert.equal(registry.isDirty(), true, "b still dirty");
  registry.remove("b");
  assert.equal(registry.isDirty(), false, "unmount cleanup removes the form");
  registry.remove("b");
  registry.set("c", true);
  registry.clear();
  assert.equal(registry.isDirty(), false);
  const before = notified;
  registry.clear();
  assert.equal(notified, before, "clearing a clean registry is silent");
  unsubscribe();
  registry.set("d", true);
  assert.equal(notified, before, "unsubscribed listeners are not called");
});

function selectorHarness(dirty: boolean) {
  const state: unknown[] = [];
  let position = 0;
  const effects: Array<() => void> = [];
  const calls = { fetches: [] as string[], discards: 0, reloads: 0 };
  const react = {
    useState(initial: unknown) {
      const i = position++;
      if (!(i in state)) state[i] = initial;
      return [state[i], (next: unknown) => { state[i] = typeof next === "function" ? (next as (v: unknown) => unknown)(state[i]) : next; }];
    },
    useEffect(run: () => void) { if (effects.length < 1) effects.push(run); },
  };
  const jsx = (type: unknown, props: object) => ({ type, props });
  const exports = load("src/components/brand/brand-selector.tsx", (name) => {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "@/components/brand/brand-fetch") return { useBrandRawFetch: () => async (url: string) => { calls.fetches.push(url); return { ok: true }; } };
    if (name === "@/components/experience/client-utils") return { getErrorMessage: (e: Error) => e.message };
    if (name === "@/components/confirm-destructive") return { ConfirmDestructive: "ConfirmDestructive" };
    if (name === "@/hooks/use-unsaved-changes") return { useAnyUnsavedChanges: () => dirty, discardUnsavedChanges: () => { calls.discards++; } };
    throw new Error(`Unexpected dependency ${name}`);
  }, {
    fetch: async () => ({ ok: true, json: async () => ({ data: { brands: [{ id: "b1", name: "One", slug: "one", membershipRole: "ADMIN" }, { id: "b2", name: "Two", slug: "two", membershipRole: "ADMIN" }], activeBrandId: "b1", selectionRequired: false } }) }),
    window: { location: { reload: () => { calls.reloads++; } } },
  });
  const render = () => { position = 0; return (exports.BrandSelector as () => Node)(); };
  return { calls, render, async ready() { render(); effects.forEach((run) => run()); await new Promise<void>((r) => setImmediate(r)); await new Promise<void>((r) => setImmediate(r)); } };
}

test("brand selector asks before switching when a form is dirty, and confirming switches", async () => {
  const harness = selectorHarness(true);
  await harness.ready();
  const select = nodes(harness.render()).find((n) => n.type === "select")!;
  (select.props.onChange as (e: object) => void)({ target: { value: "b2" } });
  await new Promise<void>((r) => setImmediate(r));
  const dialog = nodes(harness.render()).find((n) => n.type === "ConfirmDestructive")!;
  assert.equal(dialog.props.open, true);
  assert.equal(dialog.props.title, "Discard unsaved changes?");
  assert.match(String(dialog.props.description), /Two/);
  assert.deepEqual(harness.calls.fetches, [], "nothing is switched before confirmation");
  // Cancelling closes the dialog without switching.
  (dialog.props.onOpenChange as (open: boolean) => void)(false);
  assert.equal(nodes(harness.render()).find((n) => n.type === "ConfirmDestructive")!.props.open, false);
  assert.deepEqual(harness.calls.fetches, []);
  // Ask again and confirm.
  (select.props.onChange as (e: object) => void)({ target: { value: "b2" } });
  const reopened = nodes(harness.render()).find((n) => n.type === "ConfirmDestructive")!;
  await (reopened.props.onConfirm as () => Promise<void>)();
  assert.deepEqual(harness.calls.fetches, ["/api/brand/context"]);
  assert.equal(harness.calls.discards, 1, "dirty registry is cleared so beforeunload does not prompt again");
  assert.equal(harness.calls.reloads, 1);
});

test("brand selector switches immediately when nothing is dirty", async () => {
  const harness = selectorHarness(false);
  await harness.ready();
  const select = nodes(harness.render()).find((n) => n.type === "select")!;
  (select.props.onChange as (e: object) => void)({ target: { value: "b2" } });
  await new Promise<void>((r) => setImmediate(r));
  assert.deepEqual(harness.calls.fetches, ["/api/brand/context"]);
  assert.equal(harness.calls.reloads, 1);
  assert.equal(nodes(harness.render()).find((n) => n.type === "ConfirmDestructive")!.props.open, false);
});

function partialResult(props: object) {
  const jsx = (type: unknown, p: object) => ({ type, props: p });
  const exports = load("src/components/partial-result.tsx", (name) => {
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "@/components/ui/button") return { Button: "Button" };
    throw new Error(`Unexpected dependency ${name}`);
  });
  return (exports.PartialResult as (p: object) => Node)(props);
}

test("partial result names the saved part, the failed part, the reason and offers a retry", () => {
  let retried = 0;
  const tree = partialResult({ saved: "Experience details", failed: "Cover image", reason: "File too large", retryLabel: "Retry cover upload", onRetry: () => retried++ });
  const text = content(tree);
  assert.match(text, /Saved: Experience details\./);
  assert.match(text, /Not saved: Cover image \(File too large\)\./);
  const retry = nodes(tree).find((n) => n.type === "Button")!;
  assert.equal(content(retry), "Retry cover upload");
  assert.equal(retry.props.disabled, false);
  (retry.props.onClick as () => void)();
  assert.equal(retried, 1);
  assert.equal(tree.props.role, "alert");
  const busy = nodes(partialResult({ saved: "A", failed: "B", onRetry() {}, retrying: true })).find((n) => n.type === "Button")!;
  assert.equal(busy.props.disabled, true);
  assert.equal(nodes(partialResult({ saved: "A", failed: "B" })).some((n) => n.type === "Button"), false, "no retry button without a handler");
});

test("the experience form shows the partial result and keeps the form when only the cover fails", () => {
  const source = readFileSync("src/components/creator/experience-form.tsx", "utf8");
  assert.match(source, /<PartialResult/);
  assert.match(source, /saved="Experience details"/);
  assert.match(source, /failed="Cover image"/);
  assert.match(source, /if \(detailsSaved && coverAttempted\) \{[\s\S]*?setCoverFailure[\s\S]*?return;/);
});
