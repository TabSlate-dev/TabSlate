import type { SyncPushPayload } from "./api";
import { syncConflictRegistry, type SyncEntityReference } from "./sync-conflicts";

export interface SyncQueueConflictRegistry {
  ready(): Promise<void>;
  clearEntities(references: SyncEntityReference[]): Promise<void>;
  filterPayload(payload: SyncPushPayload): SyncPushPayload;
  recordPayload(payload: SyncPushPayload, status: number): Promise<void>;
}

export const syncQueueConflictRegistry: SyncQueueConflictRegistry = syncConflictRegistry;
