import { LoadingState } from "@/components/ui/loading-state";

export default function DashboardLoading() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center p-4">
      <LoadingState label="Loading dashboard…" />
    </div>
  );
}
