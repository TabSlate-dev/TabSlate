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
import { useWorkspaceStore } from "@/store/workspace-store";
import { generateId } from "@/lib/id";

interface TabsState {
  openTabs: BrowserTab[];
  tabGroups: BrowserTabGroup[];
  fullTitles: Record<number, string>;
  isLoading: boolean;
  highlightedTabIds: number[];

  // Set highlighted tabs
  setHighlightedTabs: (tabIds: number[], durationMs?: number) => void;

  // Load
  loadTabs: (silent?: boolean) => Promise<void>;

  // Tab actions
  closeTab: (tabId: number) => Promise<void>;
  focusTab: (tabId: number, windowId: number) => Promise<void>;
  ungroupSpecificTabs: (tabIds: number[]) => Promise<void>;
  closeSpecificTabs: (tabIds: number[]) => Promise<void>;
  moveTabsToGroup: (tabIds: number[], groupId: number) => Promise<void>;

  // Group actions
  createGroup: (tabIds: number[], title: string, color: TabGroupColor, compact?: boolean) => Promise<void>;
  updateGroup: (groupId: number, patch: { title?: string; color?: TabGroupColor; collapsed?: boolean }) => Promise<void>;
  dissolveGroup: (groupId: number) => Promise<void>;

  // Session actions
  saveWindowAsCollection: (name: string) => Promise<void>;
  saveGroupAsCollection: (groupId: number, name: string) => Promise<void>;
  openCollectionAsGroup: (collectionId: string, title: string, color: TabGroupColor, compact?: boolean) => Promise<void>;
  openCollection: (collectionId: string) => Promise<void>;
  
  // Group actions
  toggleGroupCompact: (groupId: number) => Promise<void>;
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
          { id, name, count, timestamp: Date.now() },
        ]),
      },
      r
    )
  );
}

const getAutoGroupName = () => {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${min}`;
};

export const useTabsStore = create<TabsState>((set, get) => ({
  openTabs: [],
  tabGroups: [],
  fullTitles: {},
  isLoading: false,
  highlightedTabIds: [],

  // -------------------------------------------------------------------------
  // Highlight
  // -------------------------------------------------------------------------
  setHighlightedTabs: (tabIds, durationMs = 3000) => {
    set({ highlightedTabIds: tabIds });
    if (tabIds.length > 0) {
      setTimeout(() => {
        const { highlightedTabIds: current } = get();
        // Clear if the IDs are still the same (avoiding racing condition if clicked twice)
        if (current === tabIds) {
          set({ highlightedTabIds: [] });
        }
      }, durationMs);
    }
  },

  // -------------------------------------------------------------------------
  // Load
  // -------------------------------------------------------------------------
  loadTabs: async (silent = false) => {
    if (!silent) set({ isLoading: true });
    const [tabs, groups, storage] = await Promise.all([
      getCurrentWindowTabs(),
      getCurrentWindowGroups(),
      chrome.storage.local.get("tabmaster-full-titles"),
    ]);
    const fullTitles = (storage["tabmaster-full-titles"] || {}) as Record<number, string>;
    set({ openTabs: tabs, tabGroups: groups, fullTitles, isLoading: false });
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
    // Silent reload to update "active" state without unmounting components
    await get().loadTabs(true);
  },
  
  ungroupSpecificTabs: async (tabIds) => {
    const { ungroupTabs } = await import("@/lib/chrome/tab-groups");
    await ungroupTabs(tabIds);
    await get().loadTabs(true);
  },

  closeSpecificTabs: async (tabIds) => {
    const { closeTab } = await import("@/lib/chrome/tabs");
    await Promise.all(tabIds.map((id) => closeTab(id)));
    await get().loadTabs(true);
  },

  moveTabsToGroup: async (tabIds, groupId) => {
    if (!tabIds.length) return;
    await chrome.tabs.group({ tabIds: tabIds as [number, ...number[]], groupId });
    await get().loadTabs(true);
  },

  // -------------------------------------------------------------------------
  // Group actions
  // -------------------------------------------------------------------------
  createGroup: async (tabIds, title, color, compact) => {
    const { compactGroupTitles } = useWorkspaceStore.getState();
    const isCompact = compact !== undefined ? compact : compactGroupTitles;
    
    let fullTitle = title.trim();
    let chromeTitle = "";
    
    if (!fullTitle) {
      fullTitle = getAutoGroupName();
      chromeTitle = ""; // Empty as requested by user for Chrome display
    } else {
      chromeTitle = isCompact ? (fullTitle[0] || "") : fullTitle;
    }

    const groupId = await groupTabs(tabIds, chromeTitle, color);
    
    // Store full title for syncing later
    const currentTitles = { ...get().fullTitles, [groupId]: fullTitle };
    await chrome.storage.local.set({ "tabmaster-full-titles": currentTitles });

    // Reload so groupId fields on tabs are updated
    const [tabs, groups] = await Promise.all([
      getCurrentWindowTabs(),
      getCurrentWindowGroups(),
    ]);
    set({ openTabs: tabs, tabGroups: groups, fullTitles: currentTitles });
    return;
  },

  updateGroup: async (groupId, patch) => {
    const { tabGroups, fullTitles } = get();
    const group = tabGroups.find((g) => g.id === groupId);
    let finalPatch = { ...patch };
    
    if (patch.title) {
      // Store full title internally
      const nextFullTitles = { ...fullTitles, [groupId]: patch.title };
      await chrome.storage.local.set({ "tabmaster-full-titles": nextFullTitles });
      
      // If the group is currently compact (length 1), keep it compact in Chrome
      if (group && group.title.length === 1 && patch.title.length > 1) {
        finalPatch.title = patch.title[0] || "";
      }
      
      set({ fullTitles: nextFullTitles });
    }

    const updated = await updateGroup(groupId, finalPatch);
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

  openCollectionAsGroup: async (collectionId, title, color, compact) => {
    const { bookmarks } = useBookmarksStore.getState();
    const urls = bookmarks
      .filter((b) => b.collectionId === collectionId)
      .map((b) => b.url);
    if (!urls.length) return;

    const { compactGroupTitles } = useWorkspaceStore.getState();
    const isCompact = compact !== undefined ? compact : compactGroupTitles;
    
    let fullTitle = title.trim();
    let chromeTitle = "";
    
    if (!fullTitle) {
      fullTitle = getAutoGroupName();
      chromeTitle = "";
    } else {
      chromeTitle = isCompact ? (fullTitle[0] || "") : fullTitle;
    }

    const groupId = await openAsTabGroup(urls, chromeTitle, color);
    
    const currentTitles = { ...get().fullTitles, [groupId]: fullTitle };
    await chrome.storage.local.set({ "tabmaster-full-titles": currentTitles });

    // Reload after tabs open
    const [tabs, groups] = await Promise.all([
      getCurrentWindowTabs(),
      getCurrentWindowGroups(),
    ]);
    set({ openTabs: tabs, tabGroups: groups, fullTitles: currentTitles });
  },

  openCollection: async (collectionId) => {
    const { bookmarks } = useBookmarksStore.getState();
    const urls = bookmarks
      .filter((b) => b.collectionId === collectionId)
      .map((b) => b.url);
    await openUrls(urls);
  },

  toggleGroupCompact: async (groupId: number) => {
    const { tabGroups } = get();
    const group = tabGroups.find((g) => g.id === groupId);
    if (!group) return;

    const storage = await chrome.storage.local.get("tabmaster-full-titles");
    const fullTitles = (storage["tabmaster-full-titles"] || {}) as Record<number, string>;
    
    const fullTitle = fullTitles[groupId];
    
    // If we don't have a full title, but the current title is long, then the current title IS the full title
    if (!fullTitle && group.title.length > 1) {
      fullTitles[groupId] = group.title;
    }

    const currentFullTitle = fullTitles[groupId] || group.title;
    const isCurrentlyCompact = group.title.length === 1 && currentFullTitle.length > 1;
    
    // Toggle: if compact -> expand, if expanded -> compact
    const nextTitle = isCurrentlyCompact ? currentFullTitle : (currentFullTitle[0] || "");

    await updateGroup(groupId, { title: nextTitle });
    
    // Persist any new full titles
    if (!fullTitles[groupId]) fullTitles[groupId] = currentFullTitle;
    await chrome.storage.local.set({ "tabmaster-full-titles": fullTitles });

    // Reload state
    const [tabs, groups] = await Promise.all([
      getCurrentWindowTabs(),
      getCurrentWindowGroups(),
    ]);
    set({ openTabs: tabs, tabGroups: groups });
  },
}));
