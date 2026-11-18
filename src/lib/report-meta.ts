/**
 * Scope metadata every analytics response carries, additively, next to its
 * existing keys. It states what a report covers so a page can caption each panel
 * from the server's own answer instead of assuming.
 *
 * Pure and client-safe: no Prisma, no server imports.
 */

/**
 * Which date places a record in the period.
 * - `provider`: the store's own order time (orders without one use `ingested`).
 * - `ingested`: the time SQRATCH received the order.
 * - `event`: the time SQRATCH recorded the event (scans, clicks, lesson activity).
 */
export type ReportDateBasis = "provider" | "ingested" | "event";

/**
 * What the report is about. `creator` is all of the creator's own experiences.
 */
export type ReportScope = "whole brand" | "campaign" | "creator" | "experience";

export type ReportMeta = {
  /** Inclusive UTC bounds. `null` on either end means that end is open. */
  period: { start: string | null; end: string | null; timezone: "UTC" };
  dateBasis: ReportDateBasis;
  scope: ReportScope;
  /** Filters this report applied, by name. */
  appliedFilters: Record<string, string>;
  /** Filters the request named that this report does not apply. */
  unsupportedFilters: string[];
  /** Order payment statuses counted in the order figures. Empty when not an order report. */
  includedStatuses: string[];
  generatedAt: string;
  coverage: { currencies?: string[]; fallbackOrderCount?: number };
};

export const ORDER_PAYMENT_STATUSES = [
  "PENDING",
  "AUTHORIZED",
  "PARTIALLY_PAID",
  "PAID",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
  "VOIDED",
  "UNKNOWN",
] as const;

type PeriodInput = { start: Date | null; end: Date | null };

export function buildReportMeta(input: {
  period: PeriodInput;
  dateBasis: ReportDateBasis;
  scope: ReportScope;
  appliedFilters?: Record<string, string>;
  unsupportedFilters?: readonly string[];
  includedStatuses?: readonly string[];
  coverage?: ReportMeta["coverage"];
  now?: Date;
}): ReportMeta {
  return {
    period: {
      start: input.period.start ? input.period.start.toISOString() : null,
      end: input.period.end ? input.period.end.toISOString() : null,
      timezone: "UTC",
    },
    dateBasis: input.dateBasis,
    scope: input.scope,
    appliedFilters: { ...(input.appliedFilters ?? {}) },
    unsupportedFilters: [...(input.unsupportedFilters ?? [])],
    includedStatuses: [...(input.includedStatuses ?? [])],
    generatedAt: (input.now ?? new Date()).toISOString(),
    coverage: { ...(input.coverage ?? {}) },
  };
}

/** The named query parameters the request carried, for reports that do not apply them. */
export function requestedFilterNames(
  params: URLSearchParams,
  names: readonly string[],
): string[] {
  return names.filter((name) => {
    const value = params.get(name);
    return value !== null && value.trim() !== "";
  });
}

const BASIS_VALUES = new Set<string>(["provider", "ingested", "event"]);
const SCOPE_VALUES = new Set<string>(["whole brand", "campaign", "creator", "experience"]);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Validates a server-sent `meta`. `null` when absent or malformed, so a page shows no caption rather than a wrong one. */
export function parseReportMeta(value: unknown): ReportMeta | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const period = record.period as Record<string, unknown> | undefined;
  if (!period || typeof period !== "object") return null;
  const bound = (v: unknown) => v === null || typeof v === "string";
  if (!bound(period.start) || !bound(period.end) || period.timezone !== "UTC") return null;
  if (typeof record.dateBasis !== "string" || !BASIS_VALUES.has(record.dateBasis)) return null;
  if (typeof record.scope !== "string" || !SCOPE_VALUES.has(record.scope)) return null;
  const filters = record.appliedFilters as Record<string, unknown> | undefined;
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) return null;
  if (!Object.values(filters).every((item) => typeof item === "string")) return null;
  if (!isStringArray(record.unsupportedFilters) || !isStringArray(record.includedStatuses)) return null;
  if (typeof record.generatedAt !== "string") return null;
  const coverage = record.coverage as Record<string, unknown> | undefined;
  if (!coverage || typeof coverage !== "object") return null;
  if (coverage.currencies !== undefined && !isStringArray(coverage.currencies)) return null;
  if (
    coverage.fallbackOrderCount !== undefined &&
    !(typeof coverage.fallbackOrderCount === "number" && Number.isFinite(coverage.fallbackOrderCount))
  ) {
    return null;
  }
  return value as ReportMeta;
}

export const CAMPAIGN_NOT_APPLIED_NOTE = "Not filtered by campaign: shows the whole brand.";

const BASIS_LABELS: Record<ReportDateBasis, string> = {
  provider: "by the order date the store recorded",
  ingested: "by the date SQRATCH received the order",
  event: "by when SQRATCH recorded it",
};

const SCOPE_LABELS: Record<ReportScope, string> = {
  "whole brand": "whole brand",
  campaign: "selected campaign",
  creator: "all your experiences",
  experience: "selected experience",
};

function formatDay(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function describePeriod(period: ReportMeta["period"]): string {
  const start = formatDay(period.start);
  const end = formatDay(period.end);
  if (start && end) return `${start} to ${end} (UTC)`;
  if (start) return `From ${start} (UTC)`;
  if (end) return `Up to ${end} (UTC)`;
  return "All dates (UTC)";
}

function describeStatuses(statuses: readonly string[]): string | null {
  if (statuses.length === 0) return null;
  if (ORDER_PAYMENT_STATUSES.every((status) => statuses.includes(status))) {
    return "counts every payment status";
  }
  return `counts ${statuses.map((s) => s.toLowerCase().replace(/_/g, " ")).join(", ")} orders`;
}

/**
 * ONE short caption for a panel: period and timezone, date basis, scope, and,
 * where relevant, the order statuses and currencies counted. When the page has a
 * campaign filter set that this report did not apply, says so plainly instead of
 * implying the filter applies.
 */
export function describeReportScope(
  meta: ReportMeta,
  options: { campaignFilterId?: string | null } = {},
): string {
  const parts = [
    describePeriod(meta.period),
    BASIS_LABELS[meta.dateBasis],
    SCOPE_LABELS[meta.scope].replace(/^./, (c) => c.toUpperCase()),
  ];
  const statuses = describeStatuses(meta.includedStatuses);
  if (statuses) parts.push(statuses);
  const currencies = meta.coverage.currencies;
  if (currencies && currencies.length > 0) {
    parts.push(`currencies ${currencies.join(", ")}, never added together`);
  }
  const caption = `${parts.join(" · ")}.`;
  return campaignFilterNotApplied(meta, options.campaignFilterId)
    ? `${caption} ${CAMPAIGN_NOT_APPLIED_NOTE}`
    : caption;
}

/** True when a campaign filter is set on the page but this report did not apply it. */
export function campaignFilterNotApplied(
  meta: ReportMeta,
  campaignFilterId: string | null | undefined,
): boolean {
  if (!campaignFilterId) return false;
  return meta.appliedFilters.campaignId === undefined;
}
