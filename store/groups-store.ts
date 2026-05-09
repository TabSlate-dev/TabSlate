import { create } from "zustand";
import type { TabGroupColor } from "@/lib/chrome/tab-groups";
import { openAsTabGroup } from "@/lib/chrome/tab-groups";
import { generateId } from "@/lib/id";
import { idbGetAll, idbPut, idbDelete } from "@/lib/idb";
import { syncEngine } from "@/lib/sync-engine";
import type { SyncPullResponse } from "@/lib/api";

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

function toServerGroup(g: SavedGroup, tabs: GroupTab[], opts?: { isDeleted?: number }): object {
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

interface GroupsState {
  groups: SavedGroup[];
  groupTabs: GroupTab[];
  _hydrated: boolean;
  hydrate: () => Promise<void>;

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
  mergeFromServer: (resp: SyncPullResponse) => void;
  sweepUnsynced: () => void;
  enqueueAllToSync: () => void;
}

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
    set({ groups, groupTabs, _hydrated: true });
  },

  createGroup: (name, color, isCompact, workspaceId) => {
    const id = generateId();
    const group: SavedGroup = { id, name, color, isCompact, createdAt: new Date().toISOString(), seq: 0, workspaceId };
    syncEngine?.enqueue({ groups: [toServerGroup(group, [])] });
    set((state) => ({ groups: [...state.groups, group] }));
    idbPut("groups", group);
    return id;
  },

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
    if (oldName && (patch.name !== undefined || patch.color !== undefined)) {
      import("./tabs-store").then(({ useTabsStore }) => {
        const { tabGroups, fullTitles, updateGroup: updateChromeGroup } = useTabsStore.getState();
        const chromeGroup = tabGroups.find(g => (fullTitles[g.id] || g.title) === oldName);
        if (chromeGroup) {
          const chromePatch: any = {};
          if (patch.name !== undefined && (fullTitles[chromeGroup.id] || chromeGroup.title) !== patch.name) {
            chromePatch.title = patch.name;
          }
          if (patch.color !== undefined && chromeGroup.color !== patch.color) {
            chromePatch.color = patch.color;
          }
          if (Object.keys(chromePatch).length > 0) {
            updateChromeGroup(chromeGroup.id, chromePatch);
          }
        }
      });
    }
  },

  deleteGroup: (id) => {
    const group = get().groups.find(g => g.id === id);
    if (!group) { return; }
    const tabs = get().groupTabs.filter(t => t.groupId === id);
    const deletedGroup = { ...group, deletedAt: Date.now() };
    syncEngine?.enqueue({ groups: [toServerGroup(deletedGroup, tabs)] });
    idbPut("groups", deletedGroup);
    // Tabs are kept in IDB and state so they can be restored later.
    set((state) => ({
      groups: state.groups.map(g => g.id === id ? deletedGroup : g),
    }));
  },

  restoreGroup: (id) => {
    const group = get().groups.find(g => g.id === id);
    if (!group) { return; }
    const tabs = get().groupTabs.filter(t => t.groupId === id);
    const restored: SavedGroup = { ...group, deletedAt: undefined, seq: 0 };
    syncEngine?.enqueue({ groups: [toServerGroup(restored, tabs)] });
    idbPut("groups", restored);
    set((state) => ({ groups: state.groups.map(g => g.id === id ? restored : g) }));
  },

  permanentlyDeleteGroup: (id) => {
    const group = get().groups.find(g => g.id === id);
    const tabs = get().groupTabs.filter(t => t.groupId === id);
    if (group) {
      syncEngine?.enqueue({ groups: [toServerGroup(group, tabs, { isDeleted: 2 })] });
    }
    for (const t of tabs) { idbDelete("group-tabs", t.id); }
    idbDelete("groups", id);
    set((state) => ({
      groups: state.groups.filter(g => g.id !== id),
      groupTabs: state.groupTabs.filter(t => t.groupId !== id),
    }));
  },

  deleteTabFromTrash: (tabId) => {
    idbDelete("group-tabs", tabId);
    set((state) => ({ groupTabs: state.groupTabs.filter(t => t.id !== tabId) }));
  },

  addTabToGroup: (groupId, tab) => {
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
    const toEnqueue: object[] = [];
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
    await openAsTabGroup(urls, group.name, group.color, group.isCompact);
  },

  mergeFromServer: (resp) => {
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

    // Purge null-workspace groups from IDB (fire-and-forget).
    for (const id of nullWorkspaceIds) {
      idbDelete("groups", id);
    }

    // Purge permanently-deleted groups and their tabs from IDB (fire-and-forget).
    for (const id of permDeletedGroupIds) {
      idbDelete("groups", id);
    }
    for (const tabId of permDeletedTabIds) {
      idbDelete("group-tabs", tabId);
    }

    // Persist valid groups to IDB (fire-and-forget).
    const state = get();
    for (const sg of serverGroups) {
      if (nullWorkspaceIds.has(sg.id)) { continue; }
      if (permDeletedGroupIds.has(sg.id)) { continue; }
      const group = state.groups.find(g => g.id === sg.id);
      if (group) { idbPut("groups", group); }
      if (sg.deleted_at) {
        // Local tabs are preserved (see state logic above); only sync IDB if
        // server actually returned tabs for this deleted group.
        for (const t of sg.tabs) { idbPut("group-tabs", { id: t.id, groupId: t.group_id, title: t.title, url: t.url, favicon: t.favicon, position: t.position }); }
      } else {
        for (const t of state.groupTabs.filter(t => t.groupId === sg.id)) {
          idbPut("group-tabs", t);
        }
      }
    }
  },

  sweepUnsynced: () => {
    const { groups, groupTabs } = get();
    const unsynced = groups.filter(g => g.seq === 0);
    if (unsynced.length === 0) { return; }
    syncEngine?.enqueue({
      groups: unsynced.map(g => toServerGroup(g, groupTabs.filter(t => t.groupId === g.id))),
    });
  },

  enqueueAllToSync: () => {
    const { groups, groupTabs } = get();
    if (groups.length === 0) { return; }
    syncEngine?.enqueue({
      groups: groups.map(g => toServerGroup(g, groupTabs.filter(t => t.groupId === g.id))),
    });
  },
}));
