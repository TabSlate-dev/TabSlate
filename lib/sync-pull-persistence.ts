import type { SyncPullResponse } from "@/lib/api";

export interface SyncPullPersistenceActions {
  mergeWorkspaces: (response: SyncPullResponse) => Promise<void>;
  mergeGroups: (response: SyncPullResponse) => Promise<void>;
  mergeBookmarks: (response: SyncPullResponse) => Promise<void>;
  setLocalSeq: (sequence: number) => Promise<void>;
  setLocalSeqRef: (sequence: number) => void;
  beforeSweep?: () => Promise<void>;
  sweepAll: () => Promise<void>;
}

/**
 * Creates a durable pull boundary: no later sequence or sweep is observable
 * until all server entities and the sequence itself have reached IndexedDB.
 */
export async function persistPulledSyncResponse(
  response: SyncPullResponse,
  actions: SyncPullPersistenceActions,
): Promise<void> {
  await actions.mergeWorkspaces(response);
  await actions.mergeGroups(response);
  await actions.mergeBookmarks(response);
  await actions.setLocalSeq(response.server_seq);
  actions.setLocalSeqRef(response.server_seq);
  await actions.beforeSweep?.();
  await actions.sweepAll();
}
