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
    <button
      onClick={onForceSync}
      title={`${label[status]} — click to sync now`}
      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded"
      aria-label={`Sync status: ${label[status]}. Click to sync now.`}
    >
      <span className={`w-2 h-2 rounded-full ${dot[status]}`} aria-hidden="true" />
      <span>{label[status]}</span>
    </button>
  );
}
