"use client";

import { useRef, useState, type ReactNode } from "react";
import { ConfirmDestructive } from "@/components/confirm-destructive";
import { discardUnsavedChanges, hasUnsavedChanges } from "@/hooks/use-unsaved-changes";

/**
 * For in-page actions that would replace a form's contents (for example "Edit"
 * on another offer while the form has unsaved edits). `guard(action)` runs the
 * action at once when nothing is dirty; otherwise it asks first. Render `dialog`
 * once in the component. Cancelling leaves the form untouched.
 */
export function useDiscardGuard(): { guard: (action: () => void) => void; dialog: ReactNode } {
  const [open, setOpen] = useState(false);
  const pending = useRef<(() => void) | null>(null);
  const guard = (action: () => void) => {
    if (!hasUnsavedChanges()) return action();
    pending.current = action;
    setOpen(true);
  };
  const dialog = (
    <ConfirmDestructive
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) pending.current = null;
      }}
      title="Discard unsaved changes?"
      description="You have unsaved edits in the form. Loading another item replaces them. Choose Cancel to keep what you entered."
      confirmLabel="Discard and continue"
      onConfirm={() => {
        const action = pending.current;
        pending.current = null;
        setOpen(false);
        discardUnsavedChanges();
        action?.();
      }}
    />
  );
  return { guard, dialog };
}
