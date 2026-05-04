import { generateId } from "@/lib/id";
import { idbPut } from "@/lib/idb";
import type { ExtensionMessage } from "@/lib/messages";

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

    // Fallback: write directly to IDB (hydrate() will pick it up on next newtab open)
    const fullBookmark = {
      id: generateId(),
      createdAt: new Date().toISOString(),
      isFavorite: false,
      ...bookmarkData,
    };
    try {
      await idbPut("bookmarks", fullBookmark);
    } catch (err) {
      console.error("[TabSlate] IDB write failed in bookmark fallback:", err);
      return;
    }
    // newtabTab was queried above for the primary path; reuse it here
    if (newtabTab?.id) {
      chrome.tabs.sendMessage(newtabTab.id, { type: "BOOKMARKS_CHANGED" } as ExtensionMessage).catch(() => {});
    }
  });

  // -------------------------------------------------------------------------
  // Tab events — write a lightweight signal to chrome.storage.local
  // so the newtab page can react via onChanged listener
  // (Service Workers can't maintain open ports in MV3)
  // -------------------------------------------------------------------------
  async function broadcastTabChange() {
    const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL("newtab.html") });
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: "TABS_CHANGED" } as ExtensionMessage).catch(() => {});
      }
    }
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
