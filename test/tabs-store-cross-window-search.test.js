import { describe, expect, mock, test } from "bun:test";

// Current window has only tab 1; window 2 (a different Chrome window) has tab 2.
const currentWindowTabs = [
  { id: 1, title: "Current window page", url: "https://example.com/win1", favIconUrl: "", windowId: 10, active: true, index: 0, groupId: -1 },
];
const allWindowTabs = [
  ...currentWindowTabs,
  { id: 2, title: "Other window page", url: "https://example.com/win2", favIconUrl: "", windowId: 20, active: false, index: 0, groupId: -1 },
];

mock.module("@/lib/chrome/tabs", () => ({
  getCurrentWindowTabs: async () => currentWindowTabs,
  getAllTabs: async () => allWindowTabs,
  closeTab: async () => {},
  focusTab: async () => {},
  openUrls: async () => {},
}));

mock.module("@/lib/chrome/tab-groups", () => ({
  getCurrentWindowGroups: async () => [],
  groupTabs: async () => 0,
  updateGroup: async () => ({}),
  ungroupTabs: async () => {},
  openAsTabGroup: async () => 0,
}));

mock.module("@/lib/idb", () => ({
  idbGet: async () => undefined,
  idbGetAll: async () => [],
  idbPut: async () => {},
  idbDelete: async () => {},
}));

mock.module("@/store/bookmarks-store", () => ({
  useBookmarksStore: { getState: () => ({ bookmarks: new Map(), addBookmarks: () => {} }) },
}));

mock.module("@/store/workspace-store", () => ({
  useWorkspaceStore: { getState: () => ({ collections: [], activeWorkspaceId: "w1", compactGroupTitles: false }) },
}));

const { useTabsStore } = await import(`../store/tabs-store.ts?test=${Date.now()}-${Math.random()}`);

describe("tabs-store loadTabs — cross-window search", () => {
  test("openTabs stays scoped to the current window", async () => {
    await useTabsStore.getState().loadTabs(true);
    expect(useTabsStore.getState().openTabs.map((t) => t.id)).toEqual([1]);
  });

  test("allTabs includes tabs from every Chrome window", async () => {
    await useTabsStore.getState().loadTabs(true);
    expect(useTabsStore.getState().allTabs.map((t) => t.id).sort()).toEqual([1, 2]);
  });
});
