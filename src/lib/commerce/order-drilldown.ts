/**
 * Links from a report into the Order Explorer that carry the report's own scope,
 * so the destination shows the same orders the figure counted.
 *
 * Pure and client-safe. The explorer re-validates everything it reads from the
 * URL; this only builds and parses the three scope values.
 */
import { parseOrderDateBasis, type OrderDateBasis } from "./order-date-basis";

export const ORDER_EXPLORER_PATH = "/dashboard/brand/commerce/orders";

export type OrderDrilldownScope = {
  /** Inclusive UTC bounds as ISO instants, exactly as the report returned them. */
  range: { start: string; end: string };
  dateBasis: OrderDateBasis;
  /** `attributed` to open only attributed orders; omit for every order in the period. */
  attributed?: "attributed";
};

function isInstant(value: string | null): value is string {
  return value !== null && value.trim() !== "" && !Number.isNaN(new Date(value).getTime());
}

/** Explorer URL for the same period, date basis and attribution filter as the report. */
export function buildOrderExplorerHref(scope: OrderDrilldownScope): string {
  const params = new URLSearchParams();
  if (scope.attributed) params.set("attributed", scope.attributed);
  if (isInstant(scope.range.start)) params.set("dateFrom", new Date(scope.range.start).toISOString());
  if (isInstant(scope.range.end)) params.set("dateTo", new Date(scope.range.end).toISOString());
  params.set("dateBasis", scope.dateBasis);
  return `${ORDER_EXPLORER_PATH}?${params.toString()}`;
}

export type OrderDrilldownPeriod = {
  /** ISO instants. A malformed or inverted bound is dropped, never guessed. */
  dateFrom?: string;
  dateTo?: string;
  /** Only present when the URL named a valid basis. */
  dateBasis?: OrderDateBasis;
};

/** Reads the period and basis a report linked with. Anything invalid is ignored. */
export function parseOrderDrilldownPeriod(params: URLSearchParams): OrderDrilldownPeriod {
  const from = params.get("dateFrom");
  const to = params.get("dateTo");
  const validFrom = isInstant(from) ? new Date(from) : null;
  const validTo = isInstant(to) ? new Date(to) : null;
  const inverted = validFrom !== null && validTo !== null && validFrom.getTime() > validTo.getTime();
  const rawBasis = params.get("dateBasis");
  const dateBasis = rawBasis ? parseOrderDateBasis(rawBasis) : null;
  return {
    ...(validFrom && !inverted ? { dateFrom: validFrom.toISOString() } : {}),
    ...(validTo && !inverted ? { dateTo: validTo.toISOString() } : {}),
    ...(dateBasis ? { dateBasis } : {}),
  };
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/**
 * An ISO instant as the local wall-clock string a `datetime-local` input holds,
 * milliseconds included, so `new Date(value).toISOString()` returns the same
 * instant. Truncating to minutes would drop up to a minute of the period.
 */
export function instantToDateTimeLocalValue(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Caption stating which date the explorer's date filter compares against. */
export function orderExplorerDateBasisCaption(basis: OrderDateBasis): string {
  return basis === "provider"
    ? "Date filter uses the order date the store recorded; an order without one uses the date SQRATCH received it."
    : "Date filter uses the date SQRATCH received the order.";
}
