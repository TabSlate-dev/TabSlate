import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { TabGroupColor } from "@/lib/chrome/tab-groups";
import { openAsTabGroup } from "@/lib/chrome/tab-groups";
import { generateId } from "@/lib/id";
import { chromeStorageAdapter } from "@/lib/chrome-storage-adapter";

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
}

export const useGroupsStore = create<GroupsState>()(
  persist(
    (set, get) => ({
      groups: [],
      groupTabs: [],
      _hydrated: false,

      createGroup: (name, color, isCompact) => {
        const id = generateId();
        set((state) => ({
          groups: [
            ...state.groups,
            { id, name, color, isCompact, createdAt: new Date().toISOString() },
          ],
        }));
        return id;
      },

      updateGroup: (id, patch) => {
        set((state) => ({
          groups: state.groups.map((g) =>
            g.id === id ? { ...g, ...patch } : g
          ),
        }));
      },

      deleteGroup: (id) => {
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
        if (existing) return; // deduplicate
        const position = groupTabs.filter((t) => t.groupId === groupId).length;
        set((state) => ({
          groupTabs: [
            ...state.groupTabs,
            { id: generateId(), groupId, ...tab, position },
          ],
        }));
      },

      removeTabFromGroup: (tabId) => {
        set((state) => ({
          groupTabs: state.groupTabs.filter((t) => t.id !== tabId),
        }));
      },

      moveTab: (tabId, toGroupId) => {
        set((state) => {
          const tab = state.groupTabs.find((t) => t.id === tabId);
          if (!tab) return {};
          const position = state.groupTabs.filter(
            (t) => t.groupId === toGroupId
          ).length;
          return {
            groupTabs: state.groupTabs.map((t) =>
              t.id === tabId ? { ...t, groupId: toGroupId, position } : t
            ),
          };
        });
      },

      openGroup: async (groupId) => {
        const { groups, groupTabs } = get();
        const group = groups.find((g) => g.id === groupId);
        if (!group) return;
        const urls = groupTabs
          .filter((t) => t.groupId === groupId)
          .sort((a, b) => a.position - b.position)
          .map((t) => t.url);
        if (!urls.length) return;
        await openAsTabGroup(urls, group.name, group.color, group.isCompact);
      },
    }),
    {
      name: "tabmaster-groups",
      storage: createJSONStorage(() => chromeStorageAdapter),
      partialize: (state) =>
        ({
          groups: state.groups,
          groupTabs: state.groupTabs,
        } as GroupsState),
      onRehydrateStorage: () => (state) => {
        if (state) state._hydrated = true;
      },
    }
  )
);
