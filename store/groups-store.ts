import { create } from "zustand";
import type { TabGroupColor } from "@/lib/chrome/tab-groups";
import { openAsTabGroup } from "@/lib/chrome/tab-groups";
import { generateId } from "@/lib/id";
import { idbGetAll, idbPut, idbDelete, idbGetByIndex, idbTransaction } from "@/lib/idb";

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
}

interface GroupsState {
  groups: SavedGroup[];
  groupTabs: GroupTab[];
  _hydrated: boolean;
  hydrate: () => Promise<void>;

  // Group CRUD
  createGroup: (name: string, color: TabGroupColor, isCompact: boolean) => string;
  updateGroup: (id: string, patch: Partial<Pick<SavedGroup, "name" | "color" | "isCompact">>) => void;
  deleteGroup: (id: string) => Promise<void>;

  // Tab management
  addTabToGroup: (groupId: string, tab: { title: string; url: string; favicon: string }) => void;
  removeTabFromGroup: (tabId: string) => void;
  moveTab: (tabId: string, toGroupId: string) => void;

  // Open
  openGroup: (groupId: string) => Promise<void>;
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
    const group: SavedGroup = { id, name, color, isCompact, createdAt: new Date().toISOString() };
    set((state) => ({ groups: [...state.groups, group] }));
    idbPut("groups", group);
    return id;
  },

  updateGroup: (id, patch) => {
    const oldGroup = get().groups.find(g => g.id === id);
    const oldName = oldGroup?.name;

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

  deleteGroup: async (id) => {
    const tabsToDelete = await idbGetByIndex<GroupTab>("group-tabs", "groupId", id);
    await idbTransaction(["groups", "group-tabs"], "readwrite", (tx) => {
      tx.objectStore("groups").delete(id);
      for (const t of tabsToDelete) { tx.objectStore("group-tabs").delete(t.id); }
    });
    set((state) => ({
      groups: state.groups.filter((g) => g.id !== id),
      groupTabs: state.groupTabs.filter((t) => t.groupId !== id),
    }));
  },

  addTabToGroup: (groupId, tab) => {
    const { groupTabs } = get();
    const existing = groupTabs.find(
      (t) => t.groupId === groupId && t.url === tab.url
    );
    if (existing) { return; }
    const position = groupTabs.filter((t) => t.groupId === groupId).length;
    const newTab: GroupTab = { id: generateId(), groupId, ...tab, position };
    set((state) => ({
      groupTabs: [...state.groupTabs, newTab],
    }));
    idbPut("group-tabs", newTab);
  },

  removeTabFromGroup: (tabId) => {
    idbDelete("group-tabs", tabId);
    set((state) => ({
      groupTabs: state.groupTabs.filter((t) => t.id !== tabId),
    }));
  },

  moveTab: (tabId, toGroupId) => {
    const existingTab = get().groupTabs.find((t) => t.id === tabId);
    if (!existingTab || existingTab.groupId === toGroupId) { return; }
    set((state) => {
      const tab = state.groupTabs.find((t) => t.id === tabId);
      if (!tab) { return {}; }
      const position = state.groupTabs.filter(
        (t) => t.groupId === toGroupId
      ).length;
      return {
        groupTabs: state.groupTabs.map((t) =>
          t.id === tabId ? { ...t, groupId: toGroupId, position } : t
        ),
      };
    });
    const moved = get().groupTabs.find(t => t.id === tabId);
    if (moved) { idbPut("group-tabs", moved); }
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
}));
