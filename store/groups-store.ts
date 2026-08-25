import { create } from "zustand";
import type { TabGroupColor } from "@/lib/chrome/tab-groups";
import { openAsTabGroup } from "@/lib/chrome/tab-groups";
import { generateId } from "@/lib/id";
import { idbGetAll, idbGet, idbPut, idbDelete, idbBulkWrite, type BulkWriteOp } from "@/lib/idb";
import { syncEngine } from "@/lib/sync-engine";
import type { SyncEntity, SyncPullResponse } from "@/lib/api";
import { usePlanStore, guardQuota } from "@/store/plan-store";
import { normalizeFavicon } from "@/lib/bookmark-utils";
import { analytics } from "@/lib/analytics";
import { syncConflictRegistry } from "@/lib/sync-conflicts";
import type { WorkspaceAggregateIds } from "@/lib/workspace-aggregate";

export interface GroupTab {
  id: string;
  groupId: string;
  title: string;
  url: string;
  favicon: string;
  position: number;
}

export interface SavedGroup {
  id: string;
  name: string;
  color: TabGroupColor;
  isCompact: boolean;
  createdAt: string;
  seq: number;        // 0 = never synced; >0 = server-confirmed
  deletedAt?: number; // unix ms; undefined = alive
  workspaceId: string;
}

function toServerGroup(g: SavedGroup, tabs: GroupTab[], opts?: { isDeleted?: number }): SyncEntity {
  return {
    id: g.id,
    name: g.name,
    color: g.color,
    is_compact: g.isCompact,
    seq: g.seq,
    deleted_at: g.deletedAt ?? null,
    is_deleted: opts?.isDeleted ?? 0,
    created_at: new Date(g.createdAt).getTime(),
    updated_at: Date.now(),
    workspace_id: g.workspaceId,
    tabs: tabs.map(t => ({
      id: t.id,
      group_id: t.groupId,
      title: t.title,
      url: t.url,
      favicon: t.favicon,
      position: t.position,
    })),
  };
}

function buildTabsByGroup(groupTabs: GroupTab[]): Map<string, GroupTab[]> {
  const map = new Map<string, GroupTab[]>();
  for (const t of groupTabs) {
    const bucket = map.get(t.groupId) ?? [];
    bucket.push(t);
    map.set(t.groupId, bucket);
  }
  return map;
}

function groupTabMatchesSyncEntity(tab: GroupTab, entity: SyncEntity): boolean {
  return entity.id === tab.id &&
    entity.group_id === tab.groupId &&
    entity.title === tab.title &&
    entity.url === tab.url &&
    entity.favicon === tab.favicon &&
    entity.position === tab.position;
}

function isSyncEntityArray(value: SyncEntity[string]): value is SyncEntity[] {
  return Array.isArray(value) && value.every((item) => typeof item === "object");
}

function groupMatchesSyncEntity(
  group: SavedGroup,
  tabs: readonly GroupTab[],
  entity: SyncEntity,
): boolean {
  const entityTabs = entity.tabs;
  return entity.id === group.id &&
    entity.name === group.name &&
    entity.color === group.color &&
    entity.is_compact === group.isCompact &&
    entity.workspace_id === group.workspaceId &&
    entity.created_at === new Date(group.createdAt).getTime() &&
    (entity.deleted_at ?? null) === (group.deletedAt ?? null) &&
    isSyncEntityArray(entityTabs) &&
    entityTabs.length === tabs.length &&
    tabs.every((tab, index) => groupTabMatchesSyncEntity(tab, entityTabs[index]));
}

interface GroupsState {
  groups: SavedGroup[];
  groupTabs: GroupTab[];
  _hydrated: boolean;
  hydrate: () => Promise<void>;
  reset: () => void;

  // Group CRUD
  createGroup: (name: string, color: TabGroupColor, isCompact: boolean, workspaceId: string) => string;
  updateGroup: (id: string, patch: Partial<Pick<SavedGroup, "name" | "color" | "isCompact">>) => void;
  deleteGroup: (id: string) => void;
  restoreGroup: (id: string) => void;
  permanentlyDeleteGroup: (id: string) => void;

  // Tab management
  addTabToGroup: (groupId: string, tab: { title: string; url: string; favicon: string }) => void;
  removeTabFromGroup: (tabId: string) => void;
  moveTab: (tabId: string, toGroupId: string) => void;
  deleteTabFromTrash: (tabId: string) => void;

  // Open
  openGroup: (groupId: string) => Promise<void>;

  // Sync
  mergeFromServer: (resp: SyncPullResponse) => Promise<void>;
  applyGuestGroupChanges: (groups: SavedGroup[]) => void;
  sweepUnsynced: () => Promise<void>;
  enqueueAllToSync: () => void;
  confirmGroupEntitySeqs: (entities: readonly SyncEntity[], serverSeq: number) => void;
  removeWorkspaceAggregateFromState: (ids: WorkspaceAggregateIds) => void;
}

const pendingPermanentGroupIds = new Set<string>();

export const useGroupsStore = create<GroupsState>()((set, get) => ({
  groups: [],
  groupTabs: [],
  _hydrated: false,
  hydrate: async () => {
    const [allGroups, groupTabs] = await Promise.all([
      idbGetAll<SavedGroup>("groups"),
      idbGetAll<GroupTab>("group-tabs"),
    ]);
    const groups = allGroups.filter(g => {
      if (!g.workspaceId) {
        idbDelete("groups", g.id);
        return false;
      }
      return true;
    });
    const faviconMigrated = await idbGet<{ key: string; value: boolean }>("kv", "favicon-migrated-groups-v1");
    const migratedTabs = faviconMigrated?.value
      ? groupTabs
      : groupTabs.map((t): GroupTab => {
          if (!t.favicon.startsWith("data:")) {
            return t;
          }
          const fixed = { ...t, favicon: normalizeFavicon(t.favicon, t.url) };
          void idbPut("group-tabs", fixed);
          return fixed;
        });
    if (!faviconMigrated?.value) {
      await idbPut("kv", { key: "favicon-migrated-groups-v1", value: true });
    }
    set({ groups, groupTabs: migratedTabs, _hydrated: true });
  },

  reset: () => {
    set({ groups: [], groupTabs: [], _hydrated: true });
  },

  createGroup: (name, color, isCompact, workspaceId) =>
    guardQuota("saved_group", get().groups.length, "", () => {
      const id = generateId();
      const group: SavedGroup = { id, name, color, isCompact, createdAt: new Date().toISOString(), seq: 0, workspaceId };
      syncEngine?.enqueue({ groups: [toServerGroup(group, [])] });
      set((state) => ({ groups: [...state.groups, group] }));
      idbPut("groups", group);
      usePlanStore.getState().incrementUsage("saved_group");
      analytics.track("group_saved");
      return id;
    }),

  updateGroup: (id, patch) => {
    const oldGroup = get().groups.find(g => g.id === id);
    const oldName = oldGroup?.name;

    if (oldGroup) {
      const updatedForSync = { ...oldGroup, ...patch };
      const tabs = get().groupTabs.filter(t => t.groupId === id);
      syncEngine?.enqueue({ groups: [toServerGroup(updatedForSync, tabs)] });
    }

    set((state) => ({
      groups: state.groups.map((g) =>
        g.id === id ? { ...g, ...patch } : g
      ),
    }));
    const updated = get().groups.find(g => g.id === id);
    if (updated) { idbPut("groups", updated); }

    // Sync to open Chrome tab groups
    if (oldName && (patch.name !== undefined || patch.color !== undefined || patch.isCompact !== undefined)) {
      import("./tabs-store").then(({ useTabsStore }) => {
        const { tabGroups, fullTitles, updateGroup: updateChromeGroup, toggleGroupCompact } = useTabsStore.getState();
        const chromeGroup = tabGroups.find(g => (fullTitles[g.id] || g.title) === oldName);
        if (chromeGroup) {
          const chromePatch: { title?: string; color?: TabGroupColor } = {};
          if (patch.name !== undefined && (fullTitles[chromeGroup.id] || chromeGroup.title) !== patch.name) {
            chromePatch.title = patch.name;
          }
          if (patch.color !== undefined && chromeGroup.color !== patch.color) {
            chromePatch.color = patch.color;
          }
          if (Object.keys(chromePatch).length > 0) {
            updateChromeGroup(chromeGroup.id, chromePatch);
          }
          
          if (patch.isCompact !== undefined) {
             const actualFullTitle = fullTitles[chromeGroup.id] || chromeGroup.title;
             const isCurrentlyCompact = chromeGroup.title.length === 1 && actualFullTitle.length > 1;
             // If Chrome tab group compact state doesn't match the new desired state
             if (patch.isCompact !== isCurrentlyCompact) {
                 toggleGroupCompact(chromeGroup.id);
             }
          }
        }
      });
    }
  },

  deleteGroup: (id) => {
    const group = get().groups.find(g => g.id === id);
    if (!group || group.deletedAt) { return; }
    const tabs = get().groupTabs.filter(t => t.groupId === id);
    const deletedGroup = { ...group, deletedAt: Date.now() };
    syncEngine?.enqueue({ groups: [toServerGroup(deletedGroup, tabs)] });
    idbPut("groups", deletedGroup);
    // Tabs are kept in IDB and state so they can be restored later.
    set((state) => ({
      groups: state.groups.map(g => g.id === id ? deletedGroup : g),
    }));
    usePlanStore.getState().moveUsageToTrash("saved_group");
  },

  restoreGroup: (id) => {
    const group = get().groups.find(g => g.id === id);
    if (!group || !group.deletedAt) { return; }
    const tabs = get().groupTabs.filter(t => t.groupId === id);
    const restored: SavedGroup = { ...group, deletedAt: undefined, seq: 0 };
    syncEngine?.enqueue({ groups: [toServerGroup(restored, tabs)] });
    idbPut("groups", restored);
    set((state) => ({ groups: state.groups.map(g => g.id === id ? restored : g) }));
    usePlanStore.getState().restoreUsageFromTrash("saved_group");
  },

  permanentlyDeleteGroup: (id) => {
    if (pendingPermanentGroupIds.has(id)) { return; }
    const group = get().groups.find(candidate => candidate.id === id);
    if (!group || !group.deletedAt) { return; }
    const tabs = get().groupTabs.filter(tab => tab.groupId === id);
    pendingPermanentGroupIds.add(id);
    void (async () => {
      try {
        if (syncEngine) {
          await syncEngine.forcePush({ groups: [toServerGroup(group, tabs, { isDeleted: 2 })] });
        }
        await Promise.all([
          ...tabs.map((tab) => idbDelete("group-tabs", tab.id)),
          idbDelete("groups", id),
        ]);
        set((state) => ({
          groups: state.groups.filter(candidate => candidate.id !== id),
          groupTabs: state.groupTabs.filter(tab => tab.groupId !== id),
        }));
        usePlanStore.getState().decrementUsage("saved_group");
      } catch {
        return;
      } finally {
        pendingPermanentGroupIds.delete(id);
      }
    })();
  },

  deleteTabFromTrash: (tabId) => {
    idbDelete("group-tabs", tabId);
    set((state) => ({ groupTabs: state.groupTabs.filter(t => t.id !== tabId) }));
  },

  addTabToGroup: (groupId, tab) => {
    if (!groupId) { return; }
    const { groupTabs, groups } = get();
    const existing = groupTabs.find(t => t.groupId === groupId && t.url === tab.url);
    if (existing) { return; }
    const position = groupTabs.filter(t => t.groupId === groupId).length;
    const newTab: GroupTab = { id: generateId(), groupId, ...tab, position };
    const newGroupTabs = [...groupTabs, newTab];
    const group = groups.find(g => g.id === groupId);
    if (group) {
      syncEngine?.enqueue({ groups: [toServerGroup(group, newGroupTabs.filter(t => t.groupId === groupId))] });
    }
    set(() => ({ groupTabs: newGroupTabs }));
    idbPut("group-tabs", newTab);
  },

  removeTabFromGroup: (tabId) => {
    const { groups, groupTabs } = get();
    const tab = groupTabs.find(t => t.id === tabId);
    if (tab) {
      const group = groups.find(g => g.id === tab.groupId);
      const remainingTabs = groupTabs.filter(t => t.id !== tabId && t.groupId === tab.groupId);
      if (group) {
        syncEngine?.enqueue({ groups: [toServerGroup(group, remainingTabs)] });
      }
    }
    idbDelete("group-tabs", tabId);
    set((state) => ({ groupTabs: state.groupTabs.filter(t => t.id !== tabId) }));
  },

  moveTab: (tabId, toGroupId) => {
    const { groups, groupTabs } = get();
    const existingTab = groupTabs.find(t => t.id === tabId);
    if (!existingTab || existingTab.groupId === toGroupId) { return; }

    const fromGroupId = existingTab.groupId;
    const position = groupTabs.filter(t => t.groupId === toGroupId).length;
    const movedTab = { ...existingTab, groupId: toGroupId, position };
    const updatedTabs = groupTabs.map(t => t.id === tabId ? movedTab : t);

    const fromGroup = groups.find(g => g.id === fromGroupId);
    const toGroup = groups.find(g => g.id === toGroupId);
    const toEnqueue: SyncEntity[] = [];
    if (fromGroup) { toEnqueue.push(toServerGroup(fromGroup, updatedTabs.filter(t => t.groupId === fromGroupId))); }
    if (toGroup) { toEnqueue.push(toServerGroup(toGroup, updatedTabs.filter(t => t.groupId === toGroupId))); }
    if (toEnqueue.length > 0) { syncEngine?.enqueue({ groups: toEnqueue }); }

    set(() => ({ groupTabs: updatedTabs }));
    idbPut("group-tabs", movedTab);
  },

  openGroup: async (groupId) => {
    const { groups, groupTabs } = get();
    const group = groups.find((g) => g.id === groupId);
    if (!group) { return; }
    const urls = groupTabs
      .filter((t) => t.groupId === groupId)
      .sort((a, b) => a.position - b.position)
      .map((t) => t.url);
    if (!urls.length) { return; }
    const chromeGroupId = await openAsTabGroup(urls, group.name, group.color, group.isCompact);
    
    // Register the full title in tabs-store so it can sync properly later
    const { useTabsStore } = await import("./tabs-store");
    const { registerGroupFullTitle } = useTabsStore.getState();
    if (registerGroupFullTitle) {
      await registerGroupFullTitle(chromeGroupId, group.name);
    }
  },

  mergeFromServer: async (resp) => {
    const serverGroups = resp.entities.groups;
    if (!serverGroups?.length) { return; }

    // Collect null-workspace IDs before entering the set() updater (keep updater pure).
    const nullWorkspaceIds = new Set(
      serverGroups
        .filter(sg => sg.workspace_id === null || sg.workspace_id === undefined)
        .map(sg => sg.id)
    );

    // Collect permanently-deleted IDs before entering the set() updater.
    const permDeletedGroupIds = new Set(
      serverGroups
        .filter(sg => sg.is_deleted === 2)
        .map(sg => sg.id)
    );

    // Capture tab IDs for permanently-deleted groups before set() removes them from state.
    const permDeletedTabIds = get().groupTabs
      .filter(t => permDeletedGroupIds.has(t.groupId))
      .map(t => t.id);

    set((state) => {
      let groups = [...state.groups];
      let groupTabs = [...state.groupTabs];

      for (const sg of serverGroups) {
        const idx = groups.findIndex(g => g.id === sg.id);

        if (nullWorkspaceIds.has(sg.id)) {
          // Purge from state; IDB deletion happens after set() returns.
          groups = groups.filter(g => g.id !== sg.id);
          continue;
        }

        if (permDeletedGroupIds.has(sg.id)) {
          // Permanently deleted: remove from state; IDB deletion happens after set() returns.
          groups = groups.filter(g => g.id !== sg.id);
          groupTabs = groupTabs.filter(t => t.groupId !== sg.id);
          continue;
        }

        if (sg.deleted_at) {
          // Soft-deleted: update + keep in state so a future trash view can find it.
          const deletedGroup: SavedGroup = {
            id: sg.id,
            name: sg.name,
            color: sg.color as TabGroupColor,
            isCompact: sg.is_compact,
            createdAt: new Date(sg.created_at).toISOString(),
            seq: sg.seq,
            deletedAt: sg.deleted_at,
            workspaceId: sg.workspace_id ?? "",
          };
          if (idx === -1) {
            groups.push(deletedGroup);
          } else {
            groups[idx] = deletedGroup;
          }
          // Server always cascade-deletes group_tabs on push, so the pull response
          // returns tabs: [] for soft-deleted groups. Preserve local tabs so the
          // trash view can still show them; only replace if server sends real data.
          if (sg.tabs.length > 0) {
            groupTabs = groupTabs.filter(t => t.groupId !== sg.id);
            for (const st of sg.tabs) {
              groupTabs.push({
                id: st.id,
                groupId: st.group_id,
                title: st.title,
                url: st.url,
                favicon: st.favicon,
                position: st.position,
              });
            }
          }
        } else {
          // Active: LWW — server wins.
          const updatedGroup: SavedGroup = {
            id: sg.id,
            name: sg.name,
            color: sg.color as TabGroupColor,
            isCompact: sg.is_compact,
            createdAt: new Date(sg.created_at).toISOString(),
            seq: sg.seq,
            workspaceId: sg.workspace_id ?? "",
          };
          if (idx === -1) {
            groups.push(updatedGroup);
          } else {
            groups[idx] = updatedGroup;
          }
          // Replace tab snapshot: remove old tabs then add server tabs.
          groupTabs = groupTabs.filter(t => t.groupId !== sg.id);
          for (const st of sg.tabs ?? []) {
            groupTabs.push({
              id: st.id,
              groupId: st.group_id,
              title: st.title,
              url: st.url,
              favicon: st.favicon,
              position: st.position,
            });
          }
        }
      }

      return { groups, groupTabs };
    });

    const idbOps: BulkWriteOp[] = [
      ...[...nullWorkspaceIds].map((id) => ({ type: "delete" as const, store: "groups" as const, key: id })),
      ...[...permDeletedGroupIds].map((id) => ({ type: "delete" as const, store: "groups" as const, key: id })),
      ...permDeletedTabIds.map((id) => ({ type: "delete" as const, store: "group-tabs" as const, key: id })),
    ];

    // Persist valid groups and their current tab snapshots atomically.
    const state = get();
    for (const sg of serverGroups) {
      if (nullWorkspaceIds.has(sg.id)) { continue; }
      if (permDeletedGroupIds.has(sg.id)) { continue; }
      const group = state.groups.find(g => g.id === sg.id);
      if (group) { idbOps.push({ type: "put", store: "groups", value: group }); }
      if (sg.deleted_at) {
        // Local tabs are preserved (see state logic above); only sync IDB if
        // server actually returned tabs for this deleted group.
        for (const t of sg.tabs) {
          idbOps.push({ type: "put", store: "group-tabs", value: {
            id: t.id, groupId: t.group_id, title: t.title, url: t.url, favicon: t.favicon, position: t.position,
          } });
        }
      } else {
        for (const t of state.groupTabs.filter(t => t.groupId === sg.id)) {
          idbOps.push({ type: "put", store: "group-tabs", value: t });
        }
      }
    }
    await idbBulkWrite(idbOps);
  },

  applyGuestGroupChanges: (updatedGroups) => {
    if (updatedGroups.length === 0) { return; }
    const updates = new Map(updatedGroups.map((group) => [group.id, group]));
    set((state) => {
      const groups = state.groups.map((group) => updates.get(group.id) ?? group);
      for (const group of updatedGroups) {
        if (!state.groups.some((current) => current.id === group.id)) {
          groups.push(group);
        }
      }
      return { groups };
    });
  },

  sweepUnsynced: async () => {
    await syncConflictRegistry.ready();
    const { groups, groupTabs } = get();
    const unsynced = groups.filter(g => g.seq === 0);
    if (unsynced.length === 0) { return; }
    const tabsByGroup = buildTabsByGroup(groupTabs);
    const payload = syncConflictRegistry.filterPayload({
      entities: {
        workspaces: [],
        collections: [],
        bookmarks: [],
        tags: [],
        groups: unsynced.map(g => toServerGroup(g, tabsByGroup.get(g.id) ?? [])),
      },
    });
    if (payload.entities.groups.length > 0) {
      syncEngine?.enqueue(payload.entities, "respect");
    }
  },

  confirmGroupEntitySeqs: (entities, serverSeq) => {
    const entitiesById = new Map(entities.map((entity) => [entity.id, entity]));
    set((state) => ({
      groups: state.groups.map((group) => {
        const entity = entitiesById.get(group.id);
        const tabs = state.groupTabs.filter((tab) => tab.groupId === group.id);
        return entity && groupMatchesSyncEntity(group, tabs, entity)
          ? { ...group, seq: serverSeq }
          : group;
      }),
    }));
  },

  removeWorkspaceAggregateFromState: (ids) => {
    const groupIds = new Set(ids.groupIds);
    const groupTabIds = new Set(ids.groupTabIds);
    set((state) => ({
      groups: state.groups.filter((group) => !groupIds.has(group.id)),
      groupTabs: state.groupTabs.filter(
        (tab) => !groupIds.has(tab.groupId) && !groupTabIds.has(tab.id),
      ),
    }));
  },

  enqueueAllToSync: () => {
    const { groups, groupTabs } = get();
    if (groups.length === 0) { return; }
    const tabsByGroup = buildTabsByGroup(groupTabs);
    syncEngine?.enqueue({
      groups: groups.map(g => toServerGroup(g, tabsByGroup.get(g.id) ?? [])),
    });
  },
}));
