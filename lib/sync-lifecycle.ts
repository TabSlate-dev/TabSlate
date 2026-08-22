/** The auth store retires a UI-owned engine through this cycle-free boundary. */
export interface RetirableSyncLifecycle {
  retire(options?: SyncRetirementOptions): Promise<void>;
}

export interface SyncRetirementOptions {
  /** False when retirement is invoked from the engine's own active pull. */
  awaitCurrentPull?: boolean;
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

export async function retireActiveSyncLifecycle(options?: SyncRetirementOptions): Promise<void> {
  await activeLifecycle?.retire(options);
}
