"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Logged for developers only; the message is never rendered to the user.
    console.error(error);
  }, [error]);

  return (
    <div
      role="alert"
      className="flex min-h-[40vh] flex-col items-center justify-center gap-4 p-4 text-center"
    >
      <h2 className="text-lg font-semibold text-copy-90">
        Something went wrong
      </h2>
      <p className="max-w-md text-sm text-copy-70">
        This page could not be loaded. Try again, or use the sidebar to go to
        another section.
      </p>
      <Button type="button" onClick={() => reset()}>
        Retry
      </Button>
    </div>
  );
}
