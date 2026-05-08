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
}

function toServerGroup(g: SavedGroup, tabs: GroupTab[]): object {
  return {
    id: g.id,
    name: g.name,
    color: g.color,
    is_compact: g.isCompact,
    seq: g.seq,
    deleted_at: g.deletedAt ?? null,
    updated_at: Date.now(),
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
  createGroup: (name: string, color: TabGroupColor, isCompact: boolean) => string;
  updateGroup: (id: string, patch: Partial<Pick<SavedGroup, "name" | "color" | "isCompact">>) => void;
  deleteGroup: (id: string) => void;

  // Tab management
  addTabToGroup: (groupId: string, tab: { title: string; url: string; favicon: string }) => void;
  removeTabFromGroup: (tabId: string) => void;
  moveTab: (tabId: string, toGroupId: string) => void;

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
    const [groups, groupTabs] = await Promise.all([
      idbGetAll<SavedGroup>("groups"),
      idbGetAll<GroupTab>("group-tabs"),
    ]);
    set({ groups, groupTabs, _hydrated: true });
  },

  createGroup: (name, color, isCompact) => {
    const id = generateId();
    const group: SavedGroup = { id, name, color, isCompact, createdAt: new Date().toISOString(), seq: 0 };
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
    for (const t of tabs) { idbDelete("group-tabs", t.id); }
    set((state) => ({
      groups: state.groups.map(g => g.id === id ? deletedGroup : g),
      groupTabs: state.groupTabs.filter(t => t.groupId !== id),
    }));
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

  mergeFromServer: (_resp) => {
    // TODO: implement in Task 8
  },

  sweepUnsynced: () => {
    // TODO: implement in Task 8
  },

  enqueueAllToSync: () => {
    // TODO: implement in Task 9
  },
}));
