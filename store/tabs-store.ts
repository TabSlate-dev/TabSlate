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
import { normalizeUrl, getNormalizedUrlSet } from "@/lib/bookmark-utils";
import type { Bookmark } from "@/lib/types";
import { idbGetAll, idbPut, idbDelete } from "@/lib/idb";

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
  closeGroup: (groupId: number) => Promise<void>;

  // Session actions
  saveWindowAsCollection: (name: string, deduplicate: boolean) => Promise<{ saved: number; skipped: number }>;
  saveGroupAsCollection: (groupId: number, name: string, deduplicate: boolean) => Promise<{ saved: number; skipped: number }>;
  openCollectionAsGroup: (collectionId: string, title: string, color: TabGroupColor, compact?: boolean) => Promise<void>;
  openCollection: (collectionId: string) => Promise<void>;
  
  // Group actions
  toggleGroupCompact: (groupId: number) => Promise<void>;
}



const getAutoGroupName = () => {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${min}`;
};

// Module-level timer to avoid referential equality issues with array comparison
let _tabHighlightTimer: ReturnType<typeof setTimeout> | null = null;

async function _saveTabsToCollectionHelper(
  tabsToSave: BrowserTab[],
  name: string,
  deduplicate: boolean
) {
  if (!tabsToSave.length) { return { saved: 0, skipped: 0 }; }

  const { activeWorkspaceId, collections, createCollection } = useWorkspaceStore.getState();
  const { bookmarks, addBookmarks } = useBookmarksStore.getState();

  const now = new Date().toISOString();
  const newBookmarksData: Omit<Bookmark, "collectionId">[] = [];
  const seenUrlsInBatch = new Set<string>();
  let skippedCount = 0;

  const existingUrls = deduplicate
    ? (() => {
        const wsColIds = new Set(
          collections.filter((c) => c.workspaceId === activeWorkspaceId).map((c) => c.id)
        );
        const wsBookmarks = bookmarks.filter(
          (b) => b.collectionId === "" || wsColIds.has(b.collectionId)
        );
        return getNormalizedUrlSet(wsBookmarks);
      })()
    : new Set<string>();
  
  for (const tab of tabsToSave) {
    if (!tab.url) {
      skippedCount++;
      continue;
    }

    const normalizedUrl = normalizeUrl(tab.url);

    if (seenUrlsInBatch.has(normalizedUrl)) {
      skippedCount++;
      continue;
    }

    if (deduplicate && existingUrls.has(normalizedUrl)) {
      skippedCount++;
      continue;
    }
    
    seenUrlsInBatch.add(normalizedUrl);
    newBookmarksData.push({
      id: generateId(),
      title: tab.title,
      url: tab.url,
      favicon: tab.favIconUrl,
      description: "",
      tags: [],
      createdAt: now,
      isFavorite: false,
      seq: 0,
    });
  }

  if (newBookmarksData.length > 0) {
    const collection = createCollection(activeWorkspaceId, name, "folder");
    const finalBookmarks: Bookmark[] = newBookmarksData.map(b => ({
      ...b,
      collectionId: collection.id
    }));
    addBookmarks(finalBookmarks);
    return { saved: finalBookmarks.length, skipped: skippedCount };
  }

  return { saved: 0, skipped: skippedCount };
}

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
    if (_tabHighlightTimer) { clearTimeout(_tabHighlightTimer); }
    set({ highlightedTabIds: tabIds });
    if (tabIds.length > 0) {
      _tabHighlightTimer = setTimeout(() => {
        set({ highlightedTabIds: [] });
        _tabHighlightTimer = null;
      }, durationMs);
    }
  },

  // -------------------------------------------------------------------------
  // Load
  // -------------------------------------------------------------------------
  loadTabs: async (silent = false) => {
    if (!silent) { set({ isLoading: true }); }
    const [tabs, groups, titleEntries] = await Promise.all([
      getCurrentWindowTabs(),
      getCurrentWindowGroups(),
      idbGetAll<{ groupId: number; title: string }>("tab-group-titles"),
    ]);
    const fullTitles = titleEntries.reduce<Record<number, string>>(
      (acc, e) => { acc[e.groupId] = e.title; return acc; },
      {},
    );
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
    await ungroupTabs(tabIds);
    await get().loadTabs(true);
  },

  closeSpecificTabs: async (tabIds) => {
    await Promise.all(tabIds.map((id) => closeTab(id)));
    await get().loadTabs(true);
  },

  moveTabsToGroup: async (tabIds, groupId) => {
    if (!tabIds.length) { return; }
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
    idbPut("tab-group-titles", { groupId, title: fullTitle });

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
      idbPut("tab-group-titles", { groupId, title: patch.title });
      
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
    const { openTabs, fullTitles } = get();
    const tabIds = openTabs.filter((t) => t.groupId === groupId).map((t) => t.id);
    if (tabIds.length) { await ungroupTabs(tabIds); }
    idbDelete("tab-group-titles", groupId);
    const updatedTitles = { ...fullTitles };
    delete updatedTitles[groupId];
    const [tabs, groups] = await Promise.all([
      getCurrentWindowTabs(),
      getCurrentWindowGroups(),
    ]);
    set({ openTabs: tabs, tabGroups: groups, fullTitles: updatedTitles });
  },

  closeGroup: async (groupId) => {
    const { openTabs } = get();
    const tabIds = openTabs.filter((t) => t.groupId === groupId).map((t) => t.id);
    if (tabIds.length) {
      await Promise.all(tabIds.map((id) => closeTab(id)));
    }
    await get().loadTabs(true);
  },

  // -------------------------------------------------------------------------
  // Session actions
  // -------------------------------------------------------------------------
  saveWindowAsCollection: async (name, deduplicate) => {
    const { openTabs } = get();
    return await _saveTabsToCollectionHelper(openTabs, name, deduplicate);
  },

  saveGroupAsCollection: async (groupId, name, deduplicate) => {
    const { openTabs } = get();
    const groupTabs = openTabs.filter((t) => t.groupId === groupId);
    return await _saveTabsToCollectionHelper(groupTabs, name, deduplicate);
  },

  openCollectionAsGroup: async (collectionId, title, color, compact) => {
    const { bookmarks } = useBookmarksStore.getState();
    const urls = bookmarks
      .filter((b) => b.collectionId === collectionId)
      .map((b) => b.url);
    if (!urls.length) { return; }

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
    idbPut("tab-group-titles", { groupId, title: fullTitle });

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
    const { tabGroups, fullTitles } = get();
    const group = tabGroups.find((g) => g.id === groupId);
    if (!group) { return; }

    let storedFullTitle = fullTitles[groupId];
    if (!storedFullTitle && group.title.length > 1) {
      storedFullTitle = group.title;
    }

    const currentFullTitle = storedFullTitle || group.title;
    const isCurrentlyCompact = group.title.length === 1 && currentFullTitle.length > 1;
    const nextTitle = isCurrentlyCompact ? currentFullTitle : (currentFullTitle[0] || "");

    await updateGroup(groupId, { title: nextTitle });

    const updatedTitles = { ...fullTitles };
    if (!updatedTitles[groupId]) { updatedTitles[groupId] = currentFullTitle; }
    idbPut("tab-group-titles", { groupId, title: updatedTitles[groupId] });

    const [tabs, groups] = await Promise.all([
      getCurrentWindowTabs(),
      getCurrentWindowGroups(),
    ]);
    set({ openTabs: tabs, tabGroups: groups, fullTitles: updatedTitles });
  },
}));
