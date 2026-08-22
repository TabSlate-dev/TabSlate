import {
  isSyncEntityType,
  type SyncEntityType,
  type SyncEntity,
  type SyncPushPayload,
  type SyncRejected,
} from "@/lib/api";
import { idbBulkWrite, idbDelete, idbGet, type BulkWriteOp } from "@/lib/idb";

export const SYNC_CONFLICTS_KEY = "sync-conflicts-v1";

export interface SyncConflict {
  entityType: SyncEntityType;
  entityId: string;
  reason: string;
  parentType?: SyncEntityType;
  parentId?: string;
  createdAt: number;
}

export interface SyncEntityReference {
  entityType: SyncEntityType;
  entityId: string;
}

export interface SyncConflictMutation {
  entries: SyncConflict[];
  operation: BulkWriteOp;
  generation: number;
  revision: number;
}

interface SyncConflictStorageValue {
  version: 1;
  entries: SyncConflict[];
}

interface SyncConflictStorageRecord {
  key: typeof SYNC_CONFLICTS_KEY;
  value: SyncConflictStorageValue;
}

function conflictKey(entityType: SyncEntityType, entityId: string): string {
  return `${entityType}:${entityId}`;
}

function copyConflict(conflict: SyncConflict): SyncConflict {
  return { ...conflict };
}

function isValidStoredConflict(conflict: SyncConflict): boolean {
  if (!isSyncEntityType(conflict.entityType) || conflict.entityId.length === 0 ||
    conflict.reason.length === 0 || !Number.isFinite(conflict.createdAt)) {
    return false;
  }
  if (conflict.parentType === undefined && conflict.parentId === undefined) {
    return true;
  }
  return conflict.parentType !== undefined && conflict.parentId !== undefined &&
    isSyncEntityType(conflict.parentType) && conflict.parentId.length > 0;
}

function stringProperty(entity: SyncEntity, key: string): string | undefined {
  const value = entity[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export class SyncConflictRegistry {
  private readonly conflicts = new Map<string, SyncConflict>();
  private readonly hydration: Promise<void>;
  private generation = 0;
  private revision = 0;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor() {
    this.hydration = this.hydrate();
  }

  ready(): Promise<void> {
    return this.hydration;
  }

  list(): SyncConflict[] {
    return [...this.conflicts.values()].map(copyConflict);
  }

  isBlocked(entityType: SyncEntityType, entityId: string): boolean {
    return this.conflicts.has(conflictKey(entityType, entityId));
  }

  async recordRejections(rejections: SyncRejected[]): Promise<void> {
    const generation = this.generation;
    await this.enqueueMutation(generation, () => {
      const candidate = this.copyConflicts();
      let changed = false;
      for (const rejection of rejections) {
        if (rejection.reason === "stale" || !isSyncEntityType(rejection.type) || rejection.id.length === 0) {
          continue;
        }
        const parentType = isSyncEntityType(rejection.parent_type) ? rejection.parent_type : undefined;
        const parentId = parentType !== undefined && rejection.parent_id !== undefined && rejection.parent_id.length > 0
          ? rejection.parent_id
          : undefined;
        const existing = candidate.get(conflictKey(rejection.type, rejection.id));
        const conflict: SyncConflict = {
          entityType: rejection.type,
          entityId: rejection.id,
          reason: rejection.reason,
          ...(parentType !== undefined && parentId !== undefined ? { parentType, parentId } : {}),
          createdAt: existing?.createdAt ?? Date.now(),
        };
        candidate.set(conflictKey(conflict.entityType, conflict.entityId), conflict);
        changed = true;
      }
      return changed ? this.createMutation([...candidate.values()]) : undefined;
    });
  }

  async recordPayload(payload: SyncPushPayload, status: number): Promise<void> {
    const generation = this.generation;
    await this.enqueueMutation(generation, () => {
      const candidate = this.copyConflicts();
      const reason = `http_${status}`;
      const conflicts = [
        ...payload.entities.workspaces.map((entity) => this.createPayloadConflict(
          candidate, "workspace", entity.id, reason,
        )),
        ...payload.entities.collections.map((entity) => this.createPayloadConflict(
          candidate, "collection", entity.id, reason, stringProperty(entity, "workspace_id"), "workspace",
        )),
        ...payload.entities.bookmarks.map((entity) => this.createPayloadConflict(
          candidate, "bookmark", entity.id, reason, stringProperty(entity, "collection_id"), "collection",
        )),
        ...payload.entities.tags.map((entity) => this.createPayloadConflict(candidate, "tag", entity.id, reason)),
        ...payload.entities.groups.map((entity) => this.createPayloadConflict(
          candidate, "saved_group", entity.id, reason, stringProperty(entity, "workspace_id"), "workspace",
        )),
      ];
      for (const conflict of conflicts) {
        candidate.set(conflictKey(conflict.entityType, conflict.entityId), conflict);
      }
      return conflicts.length > 0 ? this.createMutation([...candidate.values()]) : undefined;
    });
  }

  async clearEntity(entityType: SyncEntityType, entityId: string): Promise<void> {
    await this.clearEntities([{ entityType, entityId }]);
  }

  async clearEntities(references: SyncEntityReference[]): Promise<void> {
    const generation = this.generation;
    await this.enqueueMutation(generation, () => {
      const keys = new Set(references.map((reference) => conflictKey(reference.entityType, reference.entityId)));
      const entries = this.list().filter((conflict) => !keys.has(conflictKey(conflict.entityType, conflict.entityId)));
      return entries.length === this.conflicts.size ? undefined : this.createMutation(entries);
    });
  }

  prepareClearRootMutation(entityType: SyncEntityType, entityId: string): SyncConflictMutation {
    const removed = new Set([conflictKey(entityType, entityId)]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const conflict of this.conflicts.values()) {
        if (conflict.parentType === undefined || conflict.parentId === undefined) {
          continue;
        }
        const parentKey = conflictKey(conflict.parentType, conflict.parentId);
        const key = conflictKey(conflict.entityType, conflict.entityId);
        if (removed.has(parentKey) && !removed.has(key)) {
          removed.add(key);
          changed = true;
        }
      }
    }
    const entries = this.list().filter((conflict) => !removed.has(conflictKey(conflict.entityType, conflict.entityId)));
    return {
      entries,
      operation: this.createPutOperation(entries),
      generation: this.generation,
      revision: this.revision,
    };
  }

  applyMutation(mutation: SyncConflictMutation): boolean {
    if (!this.isCurrentMutation(mutation)) {
      return false;
    }
    this.replaceEntries(mutation.entries);
    this.revision += 1;
    return true;
  }

  /**
   * Commits a root clear with caller-owned IndexedDB writes under the registry's
   * exclusive mutation queue. `commit` must resolve only after its single atomic
   * transaction, including mutation.operation, has committed.
   *
   * Task 7 must pass its synchronous Zustand updates as `applyAfterCommit` rather
   * than running them after awaiting this method. The registry runs that callback
   * immediately after the final generation/revision check and registry memory
   * apply, while it still owns the exclusive queue. A `false` result means reset
   * invalidated the transaction: neither registry memory nor the callback ran.
   *
   * ```ts
   * const committed = await syncConflictRegistry.executeClearRootTransaction(
   *   "workspace",
   *   sourceWorkspaceId,
   *   async (mutation) => idbBulkWrite([...operations, mutation.operation]),
   *   () => applyWorkspaceState(),
   * );
   * ```
   */
  async executeClearRootTransaction(
    entityType: SyncEntityType,
    entityId: string,
    commit: (mutation: SyncConflictMutation) => Promise<void>,
    applyAfterCommit?: () => void,
  ): Promise<boolean> {
    const generation = this.generation;
    const operation = this.mutationTail.then(async () => {
      await this.ready();
      if (generation !== this.generation) {
        return false;
      }
      const mutation = this.prepareClearRootMutation(entityType, entityId);
      await commit(mutation);
      if (!this.applyMutation(mutation)) {
        return false;
      }
      applyAfterCommit?.();
      return true;
    });
    this.mutationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async clearRoot(entityType: SyncEntityType, entityId: string): Promise<void> {
    const generation = this.generation;
    await this.enqueueMutation(generation, () => {
      const mutation = this.prepareClearRootMutation(entityType, entityId);
      return mutation.entries.length === this.conflicts.size ? undefined : mutation;
    });
  }

  async clearAllForManualRetry(): Promise<void> {
    const generation = this.generation;
    await this.enqueueMutation(generation, () => this.conflicts.size === 0 ? undefined : this.createMutation([]));
  }

  filterPayload(payload: SyncPushPayload): SyncPushPayload {
    return {
      entities: {
        workspaces: payload.entities.workspaces.filter((entity) => !this.isBlocked("workspace", entity.id)),
        collections: payload.entities.collections.filter((entity) => !this.isBlocked("collection", entity.id)),
        bookmarks: payload.entities.bookmarks.filter((entity) => !this.isBlocked("bookmark", entity.id)),
        tags: payload.entities.tags.filter((entity) => !this.isBlocked("tag", entity.id)),
        groups: payload.entities.groups.filter((entity) => !this.isBlocked("saved_group", entity.id)),
      },
    };
  }

  reset(): void {
    this.generation += 1;
    this.revision += 1;
    this.conflicts.clear();
    const clearPersistedConflicts = this.mutationTail.then(() => idbDelete("kv", SYNC_CONFLICTS_KEY));
    this.mutationTail = clearPersistedConflicts.catch(() => undefined);
  }

  private async hydrate(): Promise<void> {
    const hydrationGeneration = this.generation;
    const record = await idbGet<SyncConflictStorageRecord>("kv", SYNC_CONFLICTS_KEY);
    if (hydrationGeneration !== this.generation) {
      return;
    }
    if (!record || record.key !== SYNC_CONFLICTS_KEY || record.value.version !== 1) {
      return;
    }
    for (const conflict of record.value.entries) {
      if (!isValidStoredConflict(conflict)) {
        continue;
      }
      this.conflicts.set(conflictKey(conflict.entityType, conflict.entityId), copyConflict(conflict));
    }
  }

  private createPayloadConflict(
    conflicts: ReadonlyMap<string, SyncConflict>,
    entityType: SyncEntityType,
    entityId: string,
    reason: string,
    parentId?: string | null,
    parentType?: SyncEntityType,
  ): SyncConflict {
    const existing = conflicts.get(conflictKey(entityType, entityId));
    return {
      entityType,
      entityId,
      reason,
      ...(parentType !== undefined && parentId !== undefined && parentId !== null && parentId.length > 0
        ? { parentType, parentId }
        : {}),
      createdAt: existing?.createdAt ?? Date.now(),
    };
  }

  private enqueueMutation(
    generation: number,
    createMutation: () => SyncConflictMutation | undefined,
  ): Promise<void> {
    const operation = this.mutationTail.then(async () => {
      await this.ready();
      if (generation !== this.generation) {
        return;
      }
      const mutation = createMutation();
      if (!mutation) {
        return;
      }
      await idbBulkWrite([mutation.operation]);
      this.applyMutation(mutation);
    });
    this.mutationTail = operation.catch(() => undefined);
    return operation;
  }

  private createMutation(entries: SyncConflict[]): SyncConflictMutation {
    return {
      entries: entries.map(copyConflict),
      operation: this.createPutOperation(entries),
      generation: this.generation,
      revision: this.revision,
    };
  }

  private isCurrentMutation(mutation: SyncConflictMutation): boolean {
    return mutation.generation === this.generation && mutation.revision === this.revision;
  }

  private copyConflicts(): Map<string, SyncConflict> {
    return new Map([...this.conflicts.entries()].map(([key, conflict]) => [key, copyConflict(conflict)]));
  }

  private createPutOperation(entries: SyncConflict[]): BulkWriteOp {
    const copiedEntries = entries.map(copyConflict);
    return {
      type: "put",
      store: "kv",
      value: {
        key: SYNC_CONFLICTS_KEY,
        value: { version: 1, entries: copiedEntries },
      },
    };
  }

  private replaceEntries(entries: SyncConflict[]): void {
    this.conflicts.clear();
    for (const conflict of entries) {
      this.conflicts.set(conflictKey(conflict.entityType, conflict.entityId), copyConflict(conflict));
    }
  }
}

export const syncConflictRegistry = new SyncConflictRegistry();
