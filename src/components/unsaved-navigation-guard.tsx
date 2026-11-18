"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDestructive } from "@/components/confirm-destructive";
import { discardUnsavedChanges, hasUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { internalNavigationTarget } from "@/lib/unsaved-navigation";

/**
 * Asks before an in-app link (sidebar, breadcrumbs, any Next `Link`) leaves a
 * page whose forms hold unsaved edits. Reload, tab close and brand switching are
 * covered elsewhere. Cancelling keeps the page, and every entered value, as it
 * was. Programmatic `router.push` after a save is not intercepted. The browser
 * Back button is not intercepted either (the browser's own reload/close prompt
 * still applies).
 */
export function UnsavedNavigationGuard() {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const lastFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // Capture phase on the document runs before React/Next handle the click.
    const onClick = (event: MouseEvent) => {
      if (!hasUnsavedChanges()) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      const target = internalNavigationTarget(
        event,
        anchor ? { href: anchor.href, target: anchor.getAttribute("target"), hasDownload: anchor.hasAttribute("download") } : null,
        { origin: window.location.origin, pathname: window.location.pathname, search: window.location.search },
      );
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      lastFocus.current = anchor;
      setPending(target);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  return (
    <ConfirmDestructive
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) {
          setPending(null);
          lastFocus.current?.focus?.();
        }
      }}
      title="Discard unsaved changes?"
      description="You have unsaved edits on this page. Leaving it discards them. Choose Cancel to stay and keep what you entered."
      confirmLabel="Discard and leave"
      onConfirm={() => {
        const target = pending;
        setPending(null);
        discardUnsavedChanges();
        if (target) router.push(target);
      }}
    />
  );
}
