import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SyncStatus } from "@/lib/sync-engine";

interface SyncStatusProps {
  status: SyncStatus;
  onForceSync: () => void;
}

export function SyncStatusIndicator({ status, onForceSync }: SyncStatusProps) {
  const dot: Record<SyncStatus, string> = {
    idle:    "bg-green-500",
    syncing: "bg-blue-500 animate-pulse",
    error:   "bg-yellow-500",
    offline: "bg-red-500",
  };

  const label: Record<SyncStatus, string> = {
    idle:    "Synced",
    syncing: "Syncing…",
    error:   "Sync error",
    offline: "Offline",
  };

  return (
    <div className="flex items-center gap-3 px-2 py-1">
      <div
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
        aria-label={`Sync status: ${label[status]}`}
      >
        <span className={`w-2 h-2 rounded-full shrink-0 ${dot[status]}`} aria-hidden="true" />
        <span>{label[status]}</span>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onForceSync}
        disabled={status === "syncing"}
        aria-label="Sync now"
        className="h-6 px-2 text-xs"
      >
        <RefreshCw className={`size-3 ${status === "syncing" ? "animate-spin" : ""}`} />
        Sync now
      </Button>
    </div>
  );
}
