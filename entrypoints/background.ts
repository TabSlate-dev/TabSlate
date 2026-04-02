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
    if (info.menuItemId !== "save-to-tabslate" || !tab?.id) return;

    // Try to get richer info from the content script
    let pageInfo: { title: string; url: string; selectedText: string; favicon: string } | null = null;
    try {
      pageInfo = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_INFO" });
    } catch {
      // content script not injected (e.g. pdf, chrome:// page) — fall back to tab info
    }

    const bookmark = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      title: pageInfo?.title ?? tab.title ?? "Untitled",
      url: info.linkUrl ?? pageInfo?.url ?? tab.url ?? "",
      favicon: pageInfo?.favicon ?? tab.favIconUrl ?? "",
      description: pageInfo?.selectedText ?? "",
      collectionId: "all",
      tags: [] as string[],
      createdAt: new Date().toISOString(),
      isFavorite: false,
    };

    // Append to persisted store key directly (store isn't loaded in background)
    const raw = await new Promise<string | null>((resolve) =>
      chrome.storage.local.get("tabslate-bookmarks", (res: any) =>
        resolve(res["tabslate-bookmarks"] ?? null)
      )
    );

    let state: { bookmarks?: typeof bookmark[] } = {};
    if (raw) {
      try { state = JSON.parse(raw)?.state ?? {}; } catch { /* ignore */ }
    }

    const updated = [bookmark, ...(state.bookmarks ?? [])];
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
