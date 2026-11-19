"use client";

import { useEffect, useId, useSyncExternalStore } from "react";

/**
 * Tiny shared registry of forms that currently hold unsaved edits. Forms report
 * through `useUnsavedChanges`; the brand selector reads it to ask before
 * switching brand. Module-level on purpose: no provider has to be mounted, so a
 * page without the brand shell still gets the `beforeunload` guard.
 */
export function createDirtyRegistry() {
  const dirty = new Set<string>();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  return {
    set(id: string, isDirty: boolean) {
      if (dirty.has(id) === isDirty) return;
      if (isDirty) dirty.add(id);
      else dirty.delete(id);
      emit();
    },
    remove(id: string) {
      if (dirty.delete(id)) emit();
    },
    /** Forget every dirty form, e.g. after the user chose to discard their edits. */
    clear() {
      if (!dirty.size) return;
      dirty.clear();
      emit();
    },
    isDirty: () => dirty.size > 0,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const registry = createDirtyRegistry();

/** Report whether this form differs from its last loaded or saved values. */
export function useUnsavedChanges(isDirty: boolean) {
  const id = useId();

  // Re-asserted after every render (a no-op when unchanged): after the user chose to
  // discard and the page stayed mounted, a still-dirty form is protected again.
  useEffect(() => {
    registry.set(id, isDirty);
  });

  useEffect(() => () => registry.remove(id), [id]);

  useEffect(() => {
    if (!isDirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      // Inert once the user has chosen to discard (registry cleared).
      if (!registry.isDirty()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [isDirty]);
}

/** True while any registered form has unsaved edits. */
export function useAnyUnsavedChanges() {
  return useSyncExternalStore(registry.subscribe, registry.isDirty, () => false);
}

/** Non-reactive read for event handlers (the navigation guard). */
export function hasUnsavedChanges() {
  return registry.isDirty();
}

/** Call right before a deliberate reload after the user confirmed discarding. */
export function discardUnsavedChanges() {
  registry.clear();
}

/** Stable JSON snapshot used to compare current form values with the saved ones. */
export function snapshotOf(value: unknown) {
  return JSON.stringify(value);
}
