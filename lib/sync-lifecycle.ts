import type { KnownSyncRejectionReason } from "@/lib/api";

export interface WorkspacePurgeResult {
  status: "completed" | "rejected";
  reason?: KnownSyncRejectionReason;
}

/** The auth store retires a UI-owned engine through this cycle-free boundary. */
export interface RetirableSyncLifecycle {
  retire(): Promise<void>;
  wakeWorkspaceLifecycle?(workspaceId: string): Promise<void>;
  purgeWorkspace?(workspaceId: string): Promise<WorkspacePurgeResult>;
}

let activeLifecycle: RetirableSyncLifecycle | null = null;

export function registerSyncLifecycle(lifecycle: RetirableSyncLifecycle): void {
  activeLifecycle = lifecycle;
}

export function unregisterSyncLifecycle(lifecycle: RetirableSyncLifecycle): void {
  if (activeLifecycle === lifecycle) {
    activeLifecycle = null;
  }
}

export async function retireActiveSyncLifecycle(): Promise<void> {
  await activeLifecycle?.retire();
}

export async function wakeActiveWorkspaceLifecycle(workspaceId: string): Promise<boolean> {
  if (!activeLifecycle?.wakeWorkspaceLifecycle) {
    return false;
  }
  await activeLifecycle.wakeWorkspaceLifecycle(workspaceId);
  return true;
}

export function purgeWorkspaceThroughActiveLifecycle(
  workspaceId: string,
): Promise<WorkspacePurgeResult> | undefined {
  return activeLifecycle?.purgeWorkspace?.(workspaceId);
}
