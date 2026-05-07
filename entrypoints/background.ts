import { generateId } from "@/lib/id";
import { idbPut } from "@/lib/idb";
import { getAllTabs, focusTab } from "@/lib/chrome/tabs";
import { searchBookmarks } from "@/lib/api";
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
    let pageInfo: { title: string; url: string; selectedText: string; favicon: string; ogTitle?: string; metaDescription?: string } | null = null;
    try {
      pageInfo = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_INFO" });
    } catch {
      // content script not injected (e.g. pdf, chrome:// page) — fall back to tab info
    }

    const bookmarkData = {
      title: pageInfo?.ogTitle || pageInfo?.title || tab.title || "Untitled",
      url: info.linkUrl ?? pageInfo?.url ?? tab.url ?? "",
      favicon: pageInfo?.favicon ?? tab.favIconUrl ?? "",
      description: pageInfo?.selectedText || pageInfo?.metaDescription || "",
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
    chrome.runtime.sendMessage({ type: "BOOKMARKS_CHANGED" } as ExtensionMessage).catch(() => {});
  });

  // -------------------------------------------------------------------------
  // Tab events — broadcast signal so newtab page can react
  // -------------------------------------------------------------------------
  async function broadcastTabChange() {
    chrome.runtime.sendMessage({ type: "TABS_CHANGED" } as ExtensionMessage).catch(() => {});
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

  chrome.tabGroups.onCreated.addListener(broadcastTabChange);
  chrome.tabGroups.onRemoved.addListener(broadcastTabChange);
  chrome.tabGroups.onUpdated.addListener(broadcastTabChange);
  chrome.tabGroups.onMoved.addListener(broadcastTabChange);

  // -------------------------------------------------------------------------
  // Global search shortcut — send OPEN_SEARCH to active tab, fallback to popup
  // -------------------------------------------------------------------------
  chrome.commands.onCommand.addListener(async (command) => {
    if (command !== "open-search") { return; }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) { return; }

    // Silently ignore if content script is not injectable (chrome://, pdf, etc.)
    chrome.tabs.sendMessage(tab.id, { type: "OPEN_SEARCH" } as ExtensionMessage).catch(() => {});
  });

  // -------------------------------------------------------------------------
  // Message routing for content script — proxy tab APIs
  // -------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
    if (message.type === "GET_OPEN_TABS") {
      getAllTabs().then(sendResponse);
      return true;
    }
    if (message.type === "FOCUS_TAB") {
      focusTab(message.tabId, message.windowId).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (message.type === "SEARCH_BOOKMARKS") {
      // Content scripts can't make cross-origin fetch calls; proxy through background.
      searchBookmarks(message.serverUrl, message.accessToken, message.query)
        .then(result => sendResponse({ ok: true, bookmarks: result.bookmarks }))
        .catch(() => sendResponse({ ok: false, bookmarks: [] }));
      return true; // keep channel open for async response
    }
  });
});
