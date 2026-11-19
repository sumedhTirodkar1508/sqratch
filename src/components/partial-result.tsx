import { Button } from "@/components/ui/button";

/**
 * Honest outcome of a multi-step save where some steps succeeded and one failed:
 * names what was saved, what was not (and why), and offers a retry for only the
 * failed part. The caller keeps the user's values; nothing here resets a form.
 */
export function PartialResult({
  saved,
  failed,
  reason,
  retryLabel = "Retry",
  retrying = false,
  onRetry,
}: {
  saved: string;
  failed: string;
  reason?: string | null;
  retryLabel?: string;
  retrying?: boolean;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="space-y-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-ink"
    >
      <p>
        <span className="font-medium">Saved:</span> {saved}.
      </p>
      <p>
        <span className="font-medium">Not saved:</span> {failed}
        {reason ? ` (${reason})` : ""}.
      </p>
      {onRetry ? (
        <Button
          type="button"
          variant="outline"
          disabled={retrying}
          onClick={onRetry}
          className="rounded-full border-edge/20 bg-transparent text-ink hover:bg-glass-10"
        >
          {retrying ? "Retrying..." : retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
