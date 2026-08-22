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
    await this.ready();
    let changed = false;
    for (const rejection of rejections) {
      if (rejection.reason === "stale" || !isSyncEntityType(rejection.type) || rejection.id.length === 0) {
        continue;
      }
      const parentType = isSyncEntityType(rejection.parent_type) ? rejection.parent_type : undefined;
      const parentId = parentType !== undefined && rejection.parent_id !== undefined && rejection.parent_id.length > 0
        ? rejection.parent_id
        : undefined;
      const existing = this.conflicts.get(conflictKey(rejection.type, rejection.id));
      const conflict: SyncConflict = {
        entityType: rejection.type,
        entityId: rejection.id,
        reason: rejection.reason,
        ...(parentType !== undefined && parentId !== undefined ? { parentType, parentId } : {}),
        createdAt: existing?.createdAt ?? Date.now(),
      };
      this.conflicts.set(conflictKey(conflict.entityType, conflict.entityId), conflict);
      changed = true;
    }
    if (changed) {
      await this.persist();
    }
  }

  async recordPayload(payload: SyncPushPayload, status: number): Promise<void> {
    await this.ready();
    const reason = `http_${status}`;
    const conflicts = [
      ...payload.entities.workspaces.map((entity) => this.createPayloadConflict("workspace", entity.id, reason)),
      ...payload.entities.collections.map((entity) => this.createPayloadConflict(
        "collection", entity.id, reason, stringProperty(entity, "workspace_id"), "workspace",
      )),
      ...payload.entities.bookmarks.map((entity) => this.createPayloadConflict(
        "bookmark", entity.id, reason, stringProperty(entity, "collection_id"), "collection",
      )),
      ...payload.entities.tags.map((entity) => this.createPayloadConflict("tag", entity.id, reason)),
      ...payload.entities.groups.map((entity) => this.createPayloadConflict(
        "saved_group", entity.id, reason, stringProperty(entity, "workspace_id"), "workspace",
      )),
    ];
    let changed = false;
    for (const conflict of conflicts) {
      this.conflicts.set(conflictKey(conflict.entityType, conflict.entityId), conflict);
      changed = true;
    }
    if (changed) {
      await this.persist();
    }
  }

  async clearEntity(entityType: SyncEntityType, entityId: string): Promise<void> {
    await this.clearEntities([{ entityType, entityId }]);
  }

  async clearEntities(references: SyncEntityReference[]): Promise<void> {
    await this.ready();
    const keys = new Set(references.map((reference) => conflictKey(reference.entityType, reference.entityId)));
    const entries = this.list().filter((conflict) => !keys.has(conflictKey(conflict.entityType, conflict.entityId)));
    if (entries.length === this.conflicts.size) {
      return;
    }
    await this.commitEntries(entries);
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
    };
  }

  applyMutation(mutation: SyncConflictMutation): void {
    this.replaceEntries(mutation.entries);
  }

  async clearRoot(entityType: SyncEntityType, entityId: string): Promise<void> {
    await this.ready();
    const mutation = this.prepareClearRootMutation(entityType, entityId);
    if (mutation.entries.length === this.conflicts.size) {
      return;
    }
    await idbBulkWrite([mutation.operation]);
    this.applyMutation(mutation);
  }

  async clearAllForManualRetry(): Promise<void> {
    await this.ready();
    if (this.conflicts.size === 0) {
      return;
    }
    await this.commitEntries([]);
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
    this.conflicts.clear();
    void idbDelete("kv", SYNC_CONFLICTS_KEY);
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
    entityType: SyncEntityType,
    entityId: string,
    reason: string,
    parentId?: string | null,
    parentType?: SyncEntityType,
  ): SyncConflict {
    const existing = this.conflicts.get(conflictKey(entityType, entityId));
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

  private async persist(): Promise<void> {
    await this.commitEntries(this.list());
  }

  private async commitEntries(entries: SyncConflict[]): Promise<void> {
    const mutation: SyncConflictMutation = {
      entries,
      operation: this.createPutOperation(entries),
    };
    await idbBulkWrite([mutation.operation]);
    this.applyMutation(mutation);
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
