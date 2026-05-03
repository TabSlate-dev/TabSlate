import { generateId } from "@/lib/id";

export default defineBackground(() => {
  // -------------------------------------------------------------------------
  // Context menus — registered once on install / update
  // -------------------------------------------------------------------------
  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
      id: "save-to-tabslate",
      title: "Save to TabSlate",
      contexts: ["page", "selection", "link"],
    });
  });

  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== "save-to-tabslate" || !tab?.id) { return; }

    // Try to get richer info from the content script
    let pageInfo: { title: string; url: string; selectedText: string; favicon: string } | null = null;
    try {
      pageInfo = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_INFO" });
    } catch {
      // content script not injected (e.g. pdf, chrome:// page) — fall back to tab info
    }

    const bookmarkData = {
      title: pageInfo?.title ?? tab.title ?? "Untitled",
      url: info.linkUrl ?? pageInfo?.url ?? tab.url ?? "",
      favicon: pageInfo?.favicon ?? tab.favIconUrl ?? "",
      description: pageInfo?.selectedText ?? "",
      collectionId: "",
      tags: [] as string[],
      seq: 0,
    };

    // Primary path: send to newtab so syncEngine picks it up immediately
    const [newtabTab] = await chrome.tabs.query({ url: chrome.runtime.getURL("newtab.html") });
    if (newtabTab?.id) {
      try {
        await chrome.tabs.sendMessage(newtabTab.id, { type: "ADD_BOOKMARK", data: bookmarkData });
        return;
      } catch { /* newtab not ready, fall through to storage */ }
    }

    // Fallback: write directly to storage (seq=0 sweep will sync on next newtab open)
    const fullBookmark = {
      id: generateId(),
      createdAt: new Date().toISOString(),
      isFavorite: false,
      ...bookmarkData,
    };

    const raw = await new Promise<string | null>((resolve) =>
      chrome.storage.local.get("tabslate-bookmarks", (res) =>
        resolve((res["tabslate-bookmarks"] as string) ?? null)
      )
    );

    let state: { bookmarks?: typeof fullBookmark[] } = {};
    if (raw) {
      try { state = JSON.parse(raw)?.state ?? {}; } catch { /* ignore */ }
    }

    const updated = [fullBookmark, ...(state.bookmarks ?? [])];
    const newRaw = JSON.stringify({ state: { ...state, bookmarks: updated } });
    await new Promise<void>((r) =>
      chrome.storage.local.set({ "tabslate-bookmarks": newRaw }, r)
    );
  });

  // -------------------------------------------------------------------------
  // Tab events — write a lightweight signal to chrome.storage.local
  // so the newtab page can react via onChanged listener
  // (Service Workers can't maintain open ports in MV3)
  // -------------------------------------------------------------------------
  function broadcastTabChange() {
    chrome.storage.local.set({ "tabslate-tabs-changed": Date.now() });
  }

  chrome.tabs.onCreated.addListener(broadcastTabChange);
  chrome.tabs.onRemoved.addListener(broadcastTabChange);
  chrome.tabs.onUpdated.addListener((_, info) => {
    if (info.status === "complete" || info.title !== undefined || info.groupId !== undefined) {
      broadcastTabChange();
    }
  });
  chrome.tabs.onActivated.addListener(broadcastTabChange);
  chrome.tabs.onMoved.addListener(broadcastTabChange);

  // Tab group events
  chrome.tabGroups.onCreated.addListener(broadcastTabChange);
  chrome.tabGroups.onRemoved.addListener(broadcastTabChange);
  chrome.tabGroups.onUpdated.addListener(broadcastTabChange);
  chrome.tabGroups.onMoved.addListener(broadcastTabChange);
});
