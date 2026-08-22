/** The auth store retires a UI-owned engine through this cycle-free boundary. */
export interface RetirableSyncLifecycle {
  retire(): Promise<void>;
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
