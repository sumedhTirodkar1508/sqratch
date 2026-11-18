/**
 * Plain-language names and one-line definitions for the order figures on the
 * conversion panels. SQRATCH records an order's total, its cumulative refunds
 * and a payment status. It does NOT record how much money was actually
 * captured, so none of these figures may be called revenue or sales collected.
 */
export const ORDER_VALUE_LABELS = {
  attributedOrderValue: {
    title: "Attributed order value",
    definition:
      "Sum of order totals for every attributed order, whatever its payment status (pending, authorized and voided orders included). This is order value, not money collected.",
  },
  refunded: {
    title: "Refunded",
    definition: "Refunds the store has reported against those orders so far.",
  },
  currentNet: {
    title: "Current net attributed order value",
    definition:
      "Order total minus refunds for paid, partially paid and partially refunded orders only. A partially paid order counts at its full order total. This is not a payment total.",
  },
} as const;

export const CONVERSION_SECTION_TITLE = "Attributed conversions & order value";

/**
 * States which date places an order in the period. Both bases describe an order
 * cohort: orders placed (or received) in the period with their CURRENT refund and
 * cancellation state. A refund on an older order changes that older period. SQRATCH
 * stores no payment or refund timestamps, so nothing here reports payments or
 * refunds by date.
 */
export function conversionDateBasisNote(basis: "provider" | "ingested"): string {
  return basis === "provider"
    ? "Orders are placed in a period by the order date the store recorded (UTC). Figures are an order cohort: orders placed in the period, with their current refund and cancellation state. A refund on an older order changes that older period and is not shown as new activity."
    : "Orders are placed in a period by the date SQRATCH received them (UTC), which can be later than the date the customer ordered. Figures show those orders with their current refund and cancellation state.";
}

export function fallbackOrdersNote(count: number): string {
  return `${count} ${count === 1 ? "order used" : "orders used"} the date SQRATCH received ${count === 1 ? "it" : "them"} because the store did not supply an order date.`;
}

/** Shown wherever attributed orders or their value appear. Never call attributed value revenue, captured payments or commission. */
export const ATTRIBUTION_NOTE =
  "Attributed orders followed a tracked SQRATCH link. Attribution does not show that SQRATCH caused the sale and is not a commission statement.";

export const CONVERSION_LIMITATIONS_NOTE =
  "SQRATCH does not record the amount actually paid, so these figures are order values, not collected payments.";

/** The two campaign breakdowns answer different questions and are never added together. */
export const ENTRY_CAMPAIGN_BREAKDOWN_TITLE = "By entry campaign (how the visitor arrived)";
export const PRODUCT_CAMPAIGN_BREAKDOWN_TITLE = "By product campaign (which campaign promoted the product)";

/** Each order counts once per distinct product it contains. */
export const PRODUCT_BREAKDOWN_TITLE = "By product";
export const PRODUCT_BREAKDOWN_NOTE =
  "Orders containing this product. An order with several products is counted once for each, so rows do not add up to total orders.";

export const FINANCIAL_STATUS_LABELS: Readonly<Record<string, string>> = {
  PENDING: "Pending",
  AUTHORIZED: "Authorized",
  PARTIALLY_PAID: "Partially paid",
  PAID: "Paid",
  PARTIALLY_REFUNDED: "Partially refunded",
  REFUNDED: "Refunded",
  VOIDED: "Voided",
  UNKNOWN: "Status not reported",
};

/** Label for the trend table's per-currency order-value columns. */
export const TREND_COLUMN_LABELS = {
  orderValue: "Attributed order value",
  refunded: "Refunded",
  currentNet: "Current net value",
} as const;
