/**
 * Decides whether a click on a link should be held for an "unsaved changes"
 * confirmation. Pure so it can be tested without a browser. Only an ordinary
 * left-click on a same-origin link that leads to a different page is held;
 * new-tab, download, hash-only and external links, and modified clicks, pass
 * through untouched.
 */
export type NavigationClick = {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
};

export type NavigationAnchor = {
  href: string;
  target: string | null;
  hasDownload: boolean;
};

export function internalNavigationTarget(
  click: NavigationClick,
  anchor: NavigationAnchor | null,
  current: { origin: string; pathname: string; search: string },
): string | null {
  if (!anchor || click.defaultPrevented || click.button !== 0) return null;
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return null;
  if (anchor.hasDownload || (anchor.target && anchor.target !== "_self")) return null;
  let url: URL;
  try {
    url = new URL(anchor.href, current.origin);
  } catch {
    return null;
  }
  if (url.origin !== current.origin) return null;
  // API routes (exports, downloads) are not page navigations.
  if (url.pathname.startsWith("/api/")) return null;
  // Same page (including hash-only changes): nothing would be discarded.
  if (url.pathname === current.pathname && url.search === current.search) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}
