import { create } from "zustand";
import {
  getCurrentWindowTabs,
  closeTab,
  focusTab,
  openUrls,
  type BrowserTab,
} from "@/lib/chrome/tabs";
import {
  getCurrentWindowGroups,
  groupTabs,
  updateGroup,
  ungroupTabs,
  openAsTabGroup,
  type BrowserTabGroup,
  type TabGroupColor,
} from "@/lib/chrome/tab-groups";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { generateId } from "@/lib/id";

interface TabsState {
  openTabs: BrowserTab[];
  tabGroups: BrowserTabGroup[];
  isLoading: boolean;

  // Load
  loadTabs: () => Promise<void>;

  // Tab actions
  closeTab: (tabId: number) => Promise<void>;
  focusTab: (tabId: number, windowId: number) => Promise<void>;

  // Group actions
  createGroup: (tabIds: number[], title: string, color: TabGroupColor) => Promise<void>;
  updateGroup: (groupId: number, patch: { title?: string; color?: TabGroupColor; collapsed?: boolean }) => Promise<void>;
  dissolveGroup: (groupId: number) => Promise<void>;

  // Session actions
  saveWindowAsCollection: (name: string) => Promise<void>;
  saveGroupAsCollection: (groupId: number, name: string) => Promise<void>;
  openCollectionAsGroup: (collectionId: string, title: string, color: TabGroupColor) => Promise<void>;
  openCollection: (collectionId: string) => Promise<void>;
}

async function persistCollection(id: string, name: string, count: number) {
  const raw = await new Promise<string | null>((r) =>
    chrome.storage.local.get("tabmaster-collections", (res: any) =>
      r(res["tabmaster-collections"] ?? null)
    )
  );
  const existing = raw ? JSON.parse(raw) : [];
  await new Promise<void>((r) =>
    chrome.storage.local.set(
      {
        "tabmaster-collections": JSON.stringify([
          ...existing,
          { id, name, icon: "bookmark", color: "blue", count },
        ]),
      },
      r
    )
  );
}

export const useTabsStore = create<TabsState>((set, get) => ({
  openTabs: [],
  tabGroups: [],
  isLoading: false,

  // -------------------------------------------------------------------------
  // Load
  // -------------------------------------------------------------------------
  loadTabs: async () => {
    set({ isLoading: true });
    const [tabs, groups] = await Promise.all([
      getCurrentWindowTabs(),
      getCurrentWindowGroups(),
    ]);
    set({ openTabs: tabs, tabGroups: groups, isLoading: false });
  },

  // -------------------------------------------------------------------------
  // Tab actions
  // -------------------------------------------------------------------------
  closeTab: async (tabId) => {
    await closeTab(tabId);
    set((state) => ({
      openTabs: state.openTabs.filter((t) => t.id !== tabId),
    }));
  },

  focusTab: async (tabId, windowId) => {
    await focusTab(tabId, windowId);
  },

  // -------------------------------------------------------------------------
  // Group actions
  // -------------------------------------------------------------------------
  createGroup: async (tabIds, title, color) => {
    const groupId = await groupTabs(tabIds, title, color);
    // Reload so groupId fields on tabs are updated
    const [tabs, groups] = await Promise.all([
      getCurrentWindowTabs(),
      getCurrentWindowGroups(),
    ]);
    set({ openTabs: tabs, tabGroups: groups });
    return;
  },

  updateGroup: async (groupId, patch) => {
    const updated = await updateGroup(groupId, patch);
    set((state) => ({
      tabGroups: state.tabGroups.map((g) =>
        g.id === groupId ? updated : g
      ),
    }));
  },

  dissolveGroup: async (groupId) => {
    const { openTabs } = get();
    const tabIds = openTabs.filter((t) => t.groupId === groupId).map((t) => t.id);
    if (tabIds.length) await ungroupTabs(tabIds);
    // Reload
    const [tabs, groups] = await Promise.all([
      getCurrentWindowTabs(),
      getCurrentWindowGroups(),
    ]);
    set({ openTabs: tabs, tabGroups: groups });
  },

  // -------------------------------------------------------------------------
  // Session actions
  // -------------------------------------------------------------------------
  saveWindowAsCollection: async (name) => {
    const { openTabs } = get();
    if (!openTabs.length) return;

    const collectionId = generateId();
    const now = new Date().toISOString();
    const newBookmarks = openTabs.map((tab) => ({
      id: generateId(),
      title: tab.title,
      url: tab.url,
      favicon: tab.favIconUrl,
      description: "",
      collectionId,
      tags: [] as string[],
      createdAt: now,
      isFavorite: false,
    }));

    const { bookmarks } = useBookmarksStore.getState();
    useBookmarksStore.setState({ bookmarks: [...newBookmarks, ...bookmarks] });
    await persistCollection(collectionId, name, newBookmarks.length);
  },

  saveGroupAsCollection: async (groupId, name) => {
    const { openTabs } = get();
    const groupTabs = openTabs.filter((t) => t.groupId === groupId);
    if (!groupTabs.length) return;

    const collectionId = generateId();
    const now = new Date().toISOString();
    const newBookmarks = groupTabs.map((tab) => ({
      id: generateId(),
      title: tab.title,
      url: tab.url,
      favicon: tab.favIconUrl,
      description: "",
      collectionId,
      tags: [] as string[],
      createdAt: now,
      isFavorite: false,
    }));

    const { bookmarks } = useBookmarksStore.getState();
    useBookmarksStore.setState({ bookmarks: [...newBookmarks, ...bookmarks] });
    await persistCollection(collectionId, name, newBookmarks.length);
  },

  openCollectionAsGroup: async (collectionId, title, color) => {
    const { bookmarks } = useBookmarksStore.getState();
    const urls = bookmarks
      .filter((b) => b.collectionId === collectionId)
      .map((b) => b.url);
    if (!urls.length) return;
    await openAsTabGroup(urls, title, color);
    // Reload after tabs open
    const [tabs, groups] = await Promise.all([
      getCurrentWindowTabs(),
      getCurrentWindowGroups(),
    ]);
    set({ openTabs: tabs, tabGroups: groups });
  },

  openCollection: async (collectionId) => {
    const { bookmarks } = useBookmarksStore.getState();
    const urls = bookmarks
      .filter((b) => b.collectionId === collectionId)
      .map((b) => b.url);
    await openUrls(urls);
  },
}));
