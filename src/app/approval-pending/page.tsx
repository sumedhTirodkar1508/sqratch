"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { signOut } from "next-auth/react";
import CommonNavbar from "@/components/commonNavbar";
import { Button } from "@/components/ui/button";

const SUPPORT_EMAIL = "support@sqratch.com";

type ApplicationStatus = "PENDING" | "APPROVED" | "REJECTED";

type ApplicationView = {
  status: ApplicationStatus;
  createdAt: string;
  reason: string | null;
  decidedAt: string | null;
};

type StatusPayload = {
  creator: ApplicationView | null;
  brand: ApplicationView | null;
};

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
}

function ApplicationCard({
  label,
  application,
}: {
  label: string;
  application: ApplicationView;
}) {
  return (
    <div
      className="rounded-2xl border border-edge/15 bg-glass-6 p-5 text-left"
      data-testid={`application-${label.toLowerCase()}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">{label} application</p>
        <span className="rounded-full border border-edge/15 px-3 py-1 text-xs uppercase tracking-wider text-copy-70">
          {application.status}
        </span>
      </div>
      <p className="mt-1 text-xs text-copy-45">
        Submitted {formatDate(application.createdAt)}
      </p>
      {application.status === "PENDING" ? (
        <p className="mt-3 text-sm text-copy-70">
          Under review. You will be notified via email once a decision is made.
        </p>
      ) : null}
      {application.status === "APPROVED" ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-copy-70">
            Your application was approved.
          </p>
          <Button asChild className="rounded-full">
            <Link href="/dashboard">Continue to dashboard</Link>
          </Button>
        </div>
      ) : null}
      {application.status === "REJECTED" ? (
        <div className="mt-3 space-y-2 text-sm text-copy-70">
          <p>Your application was not approved.</p>
          {application.reason ? <p>Reason: {application.reason}</p> : null}
          <p>
            Questions? Contact{" "}
            <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>
              {SUPPORT_EMAIL}
            </a>
            .
          </p>
        </div>
      ) : null}
    </div>
  );
}

export default function ApprovalPendingPage() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/me/application-status", {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(
          response.status === 401
            ? "Sign in to see your application status."
            : "Could not load your application status.",
        );
      }
      const body = (await response.json()) as { data?: StatusPayload };
      setStatus(body.data ?? null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load your status.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const applications = [
    status?.creator ? { label: "Creator", application: status.creator } : null,
    status?.brand ? { label: "Brand", application: status.brand } : null,
  ].filter((item): item is { label: string; application: ApplicationView } =>
    Boolean(item),
  );

  return (
    <div className="relative min-h-screen overflow-hidden bg-page text-ink">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(1200px_600px_at_50%_0%,rgba(var(--glow-primary-rgb),0.28),rgba(var(--scene-rgb),0)_70%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_500px_at_15%_25%,rgba(var(--glow-secondary-rgb),0.20),rgba(var(--scene-rgb),0)_60%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_500px_at_85%_30%,rgba(var(--glow-tertiary-rgb),0.18),rgba(var(--scene-rgb),0)_60%)]" />
      </div>

      <div className="relative z-10 flex min-h-screen flex-col">
        <CommonNavbar />

        <main className="mx-auto flex w-full max-w-4xl flex-1 items-center justify-center px-6 pt-24 pb-12">
          <div className="w-full max-w-2xl rounded-[32px] border border-edge/15 bg-glass-6 p-8 text-center shadow-[0_8px_28px_rgba(72,57,34,0.06)] dark:shadow-[0_20px_80px_rgba(0,0,0,0.35)] backdrop-blur-xl sm:p-10">
            <div className="space-y-4">
              <p className="text-sm uppercase tracking-[0.25em] text-copy-45">
                Approval Pending
              </p>
              <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
                Wait for your approval from the admin
              </h1>
              <p className="mx-auto max-w-xl text-base leading-7 text-copy-70">
                You will be notified via email once approved. Until then, your
                account cannot access the dashboard.
              </p>
            </div>

            <div className="mt-6 space-y-3" aria-live="polite">
              {error ? (
                <p className="text-sm text-red-500" role="alert">
                  {error}
                </p>
              ) : null}
              {applications.map((item) => (
                <ApplicationCard
                  key={item.label}
                  label={item.label}
                  application={item.application}
                />
              ))}
            </div>

            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Button
                type="button"
                variant="outline"
                className="rounded-full px-6"
                disabled={loading}
                onClick={() => void refresh()}
              >
                {loading ? "Checking..." : "Refresh status"}
              </Button>
              <Button
                type="button"
                className="rounded-full bg-primary px-6 text-primary-foreground hover:bg-primary/90"
                onClick={() => void signOut({ callbackUrl: "/login" })}
              >
                Return to Login
              </Button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
