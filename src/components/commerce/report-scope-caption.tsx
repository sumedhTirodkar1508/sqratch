import { ATTRIBUTION_NOTE } from "@/lib/commerce/analytics-labels";
import { describeReportScope, type ReportMeta } from "@/lib/report-meta";

/** One short line stating what a panel covers, from the server's own `meta`. Renders nothing without it. */
export function ReportScopeCaption({
  meta,
  campaignFilterId,
}: {
  meta: ReportMeta | null | undefined;
  campaignFilterId?: string | null;
}) {
  if (!meta) return null;
  return <p className="mt-1 text-xs text-copy-45">{describeReportScope(meta, { campaignFilterId })}</p>;
}

/** The attribution sentence, shown wherever attributed orders or their value appear. */
export function AttributionNote() {
  return <p className="mt-1 text-xs text-copy-45">{ATTRIBUTION_NOTE}</p>;
}
