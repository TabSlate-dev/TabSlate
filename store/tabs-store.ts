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
import { idbGet, idbGetAll, idbPut, idbDelete } from "@/lib/idb";

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
  registerGroupFullTitle: (groupId: number, fullTitle: string) => Promise<void>;
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
  const { bookmarks: bookmarksMap, addBookmarks } = useBookmarksStore.getState();
  const bookmarks = Array.from(bookmarksMap.values());

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
    let title = tab.title;
    let description = "";
    try {
      const info = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_INFO" }) as {
        ogTitle?: string;
        metaDescription?: string;
      };
      if (info.ogTitle) { title = info.ogTitle; }
      description = info.metaDescription ?? "";
    } catch {
      // Content script not injected (pdf, chrome:// page) — use tab defaults
    }
    newBookmarksData.push({
      id: generateId(),
      title,
      url: tab.url,
      favicon: tab.favIconUrl,
      description,
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

    // After a browser restart Chrome assigns new IDs to restored tab groups,
    // so IDB entries keyed by old IDs become orphaned. Two-layer recovery:
    //
    // Layer 1 — orphaned-entry reconciliation: match compact groups against
    // orphaned full-title entries by (firstChar, title.length > 1). Only match
    // when unambiguous (exactly one candidate per firstChar). Skips poisoned
    // 1-char entries (written by old buggy code) via the length > 1 guard.
    const currentGroupIds = new Set(groups.map((g) => g.id));
    const orphaned = titleEntries.filter((e) => !currentGroupIds.has(e.groupId));
    if (orphaned.length > 0) {
      const orphanedPool = [...orphaned];
      const reconcileWrites: Array<{ newId: number; oldId: number; title: string }> = [];
      for (const group of groups) {
        if (group.title.length === 1 && !fullTitles[group.id]) {
          const candidates = orphanedPool.filter((e) => e.title[0] === group.title && e.title.length > 1);
          if (candidates.length === 1) {
            const match = candidates[0];
            fullTitles[group.id] = match.title;
            reconcileWrites.push({ newId: group.id, oldId: match.groupId, title: match.title });
            orphanedPool.splice(orphanedPool.indexOf(match), 1);
          }
        }
      }
      for (const { newId, oldId, title } of reconcileWrites) {
        idbPut("tab-group-titles", { groupId: newId, title });
        idbDelete("tab-group-titles", oldId);
      }
    }

    // Layer 2 — stable kv fallback: when compact was enabled, we also wrote
    // kv["compact-group-title:${color}:${firstChar}"] = fullTitle. This key
    // does not use the ephemeral Chrome group ID, so it survives restarts even
    // when the orphaned-entry path fails (ambiguous matches, cleared IDB, etc.).
    const needsKvFallback = groups.filter(g => g.title.length === 1 && !fullTitles[g.id]);
    if (needsKvFallback.length > 0) {
      const kvEntries = await Promise.all(
        needsKvFallback.map(g =>
          idbGet<{ key: string; value: string }>("kv", `compact-group-title:${g.color}:${g.title}`)
        )
      );
      for (let i = 0; i < needsKvFallback.length; i++) {
        const entry = kvEntries[i];
        if (entry?.value) {
          fullTitles[needsKvFallback[i].id] = entry.value;
          idbPut("tab-group-titles", { groupId: needsKvFallback[i].id, title: entry.value });
        }
      }
    }

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
    set(state => ({
      openTabs: state.openTabs.map(t => ({
        ...t,
        active: t.id === tabId && t.windowId === windowId,
      })),
    }));
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
    if (!fullTitle) {
      fullTitle = getAutoGroupName();
    }
    const chromeTitle = isCompact ? (fullTitle[0] || "") : fullTitle;

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
    
    // Remember old full title for syncing to Saved Groups
    const oldTitle = group ? (fullTitles[groupId] || group.title) : undefined;
    
    if (patch.title !== undefined) {
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

    // Sync title/color changes to Saved Groups with matching names
    if (oldTitle && (patch.color !== undefined || patch.title !== undefined)) {
      const { useGroupsStore } = await import("./groups-store");
      const { groups, updateGroup: updateSavedGroup } = useGroupsStore.getState();
      const savedGroup = groups.find(g => g.name === oldTitle);
      if (savedGroup) {
        const savedPatch: any = {};
        if (patch.title !== undefined && savedGroup.name !== patch.title) savedPatch.name = patch.title;
        if (patch.color !== undefined && savedGroup.color !== patch.color) savedPatch.color = patch.color;
        
        if (Object.keys(savedPatch).length > 0) {
          updateSavedGroup(savedGroup.id, savedPatch);
        }
      }
    }
  },

  dissolveGroup: async (groupId) => {
    const { openTabs, fullTitles, tabGroups } = get();
    const group = tabGroups.find(g => g.id === groupId);
    const tabIds = openTabs.filter((t) => t.groupId === groupId).map((t) => t.id);
    if (tabIds.length) { await ungroupTabs(tabIds); }
    idbDelete("tab-group-titles", groupId);
    if (group && group.title.length === 1 && (fullTitles[groupId]?.length ?? 0) > 1) {
      idbDelete("kv", `compact-group-title:${group.color}:${group.title}`);
    }
    const updatedTitles = { ...fullTitles };
    delete updatedTitles[groupId];
    const [tabs, groups] = await Promise.all([
      getCurrentWindowTabs(),
      getCurrentWindowGroups(),
    ]);
    set({ openTabs: tabs, tabGroups: groups, fullTitles: updatedTitles });
  },

  closeGroup: async (groupId) => {
    const { openTabs, fullTitles, tabGroups } = get();
    const group = tabGroups.find(g => g.id === groupId);
    const tabIds = openTabs.filter((t) => t.groupId === groupId).map((t) => t.id);
    if (tabIds.length) {
      await Promise.all(tabIds.map((id) => closeTab(id)));
    }
    idbDelete("tab-group-titles", groupId);
    if (group && group.title.length === 1 && (fullTitles[groupId]?.length ?? 0) > 1) {
      idbDelete("kv", `compact-group-title:${group.color}:${group.title}`);
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
    const { bookmarks: bookmarksMap } = useBookmarksStore.getState();
    const bookmarks = Array.from(bookmarksMap.values());
    const urls = bookmarks
      .filter((b) => b.collectionId === collectionId)
      .map((b) => b.url);
    if (!urls.length) { return; }

    const { compactGroupTitles } = useWorkspaceStore.getState();
    const isCompact = compact !== undefined ? compact : compactGroupTitles;
    
    let fullTitle = title.trim();
    if (!fullTitle) {
      fullTitle = getAutoGroupName();
    }
    const chromeTitle = isCompact ? (fullTitle[0] || "") : fullTitle;

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
    const { bookmarks: bookmarksMap } = useBookmarksStore.getState();
    const bookmarks = Array.from(bookmarksMap.values());
    const urls = bookmarks
      .filter((b) => b.collectionId === collectionId)
      .map((b) => b.url);
    await openUrls(urls);
  },

  registerGroupFullTitle: async (groupId: number, fullTitle: string) => {
    const currentTitles = { ...get().fullTitles, [groupId]: fullTitle };
    idbPut("tab-group-titles", { groupId, title: fullTitle });

    const [tabs, groups] = await Promise.all([
      getCurrentWindowTabs(),
      getCurrentWindowGroups(),
    ]);
    set({ openTabs: tabs, tabGroups: groups, fullTitles: currentTitles });
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
    // isCurrentlyCompact is true whenever Chrome is displaying the 1-char title,
    // regardless of whether we have a stored full title. The previous check required
    // currentFullTitle.length > 1, which broke after a browser restart when the full
    // title IDB entry was orphaned and currentFullTitle fell back to the 1-char title.
    const isCurrentlyCompact = group.title.length === 1;
    const isNextCompact = !isCurrentlyCompact;
    const nextTitle = isNextCompact ? (currentFullTitle[0] || "") : currentFullTitle;

    // If turning off compact but the full title is still just 1 char (title was lost),
    // there is nothing meaningful to restore — skip the Chrome update and IDB write.
    if (!isNextCompact && nextTitle.length <= 1) { return; }

    // Directly update chrome group without triggering store's updateGroup (which overwrites full titles)
    const updated = await updateGroup(groupId, { title: nextTitle });

    const updatedTitles = { ...fullTitles };
    // Only record the full title when it is actually longer than one character.
    // Writing a 1-char title here would poison IDB and prevent future reconciliation.
    if (!updatedTitles[groupId] && currentFullTitle.length > 1) {
      updatedTitles[groupId] = currentFullTitle;
    }
    if (updatedTitles[groupId]) {
      idbPut("tab-group-titles", { groupId, title: updatedTitles[groupId] });
    }

    // Maintain stable kv entry keyed by (color, firstChar) — does not use the
    // ephemeral Chrome group ID, so it survives browser restarts.
    const kvKey = `compact-group-title:${group.color}:${isNextCompact ? nextTitle : group.title}`;
    if (isNextCompact && currentFullTitle.length > 1) {
      idbPut("kv", { key: kvKey, value: currentFullTitle });
    } else if (!isNextCompact) {
      idbDelete("kv", kvKey);
    }

    set((state) => ({ 
      tabGroups: state.tabGroups.map((g) => (g.id === groupId ? updated : g)),
      fullTitles: updatedTitles 
    }));

    // Sync isCompact change to Saved Groups
    if (currentFullTitle) {
      const { useGroupsStore } = await import("./groups-store");
      const { groups, updateGroup: updateSavedGroup } = useGroupsStore.getState();
      const savedGroup = groups.find(g => g.name === currentFullTitle);
      if (savedGroup && savedGroup.isCompact !== isNextCompact) {
        updateSavedGroup(savedGroup.id, { isCompact: isNextCompact });
      }
    }
  },
}));
