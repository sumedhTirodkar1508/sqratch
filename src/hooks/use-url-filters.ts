"use client";

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Filter state kept in the URL query string, so it survives refresh and
 * back/forward navigation and can be shared inside a team.
 *
 * Only keys named in `defaults` are managed; every other query parameter (OAuth
 * result flags, unrelated deep links) is left exactly as it is. A value equal
 * to its default is omitted, so a clean URL means default filters. Changes use
 * `router.replace`, so typing or clicking a filter does not flood history.
 *
 * Put only non-sensitive values here: dates, status, the caller's own entity
 * ids and short names. Never emails, tokens, customer identifiers or QR codes.
 */
export function readUrlFilters<T extends Record<string, string>>(defaults: T, params: URLSearchParams): T {
  const values = { ...defaults };
  for (const key of Object.keys(defaults)) {
    const raw = params.get(key);
    if (raw !== null) (values as Record<string, string>)[key] = raw;
  }
  return values;
}

export function buildUrlFilterQuery<T extends Record<string, string>>(
  defaults: T,
  current: URLSearchParams,
  patch: Partial<T>,
): string {
  const next = new URLSearchParams(current.toString());
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in defaults) || value === undefined) continue;
    if (value === "" || value === defaults[key]) next.delete(key);
    else next.set(key, value);
  }
  return next.toString();
}

export function useUrlFilters<T extends Record<string, string>>(defaults: T) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // `defaults` is a stable literal per call site; its keys are what matters.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableDefaults = useMemo(() => defaults, [JSON.stringify(defaults)]);
  const values = useMemo(() => readUrlFilters(stableDefaults, new URLSearchParams(searchParams.toString())), [stableDefaults, searchParams]);

  const setFilters = useCallback(
    (patch: Partial<T>) => {
      const query = buildUrlFilterQuery(stableDefaults, new URLSearchParams(window.location.search), patch);
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [router, pathname, stableDefaults],
  );

  return [values, setFilters] as const;
}
