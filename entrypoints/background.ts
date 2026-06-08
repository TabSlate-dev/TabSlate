import { generateId } from "@/lib/id";
import { idbPut } from "@/lib/idb";
import { getAllTabs, focusTab } from "@/lib/chrome/tabs";
import { searchBookmarks } from "@/lib/api";
import { analytics } from "@/lib/analytics";
import type { ExtensionMessage } from "@/lib/messages";

export default defineBackground(() => {
  void analytics.init();

  // Restrict session storage so content scripts cannot read it (Chrome 112+)
  chrome.storage.session.setAccessLevel({
    accessLevel: (chrome.storage.AccessLevel?.TRUSTED_CONTEXTS ?? "TRUSTED_CONTEXTS"),
  });

  // -------------------------------------------------------------------------
  // Dynamic Content Script Registration for Search Overlay
  // -------------------------------------------------------------------------
  async function syncContentScriptRegistration() {
    try {
      const hasPermission = await chrome.permissions.contains({ origins: ["<all_urls>"] });
      const scripts = await chrome.scripting.getRegisteredContentScripts();
      const isRegistered = scripts.some(s => s.id === "search-overlay");

      if (hasPermission && !isRegistered) {
        await chrome.scripting.registerContentScripts([{
          id: "search-overlay",
          matches: ["<all_urls>"],
          js: ["content-scripts/content.js"],
          runAt: "document_idle",
        }]);
      } else if (!hasPermission && isRegistered) {
        await chrome.scripting.unregisterContentScripts({ ids: ["search-overlay"] });
      }
    } catch (err) {
      console.error("[TabSlate] Failed to sync content script registration:", err);
    }
  }

  chrome.runtime.onInstalled.addListener(syncContentScriptRegistration);
  chrome.runtime.onInstalled.addListener((details) => {
    const version = chrome.runtime.getManifest().version;

    if (details.reason === "install") {
      analytics.track("extension_installed", { version });
    }

    if (details.reason === "update") {
      analytics.track("extension_updated", {
        version,
        previousVersion: details.previousVersion ?? "",
      });
    }
  });
  chrome.runtime.onStartup.addListener(syncContentScriptRegistration);
  chrome.permissions.onAdded.addListener(syncContentScriptRegistration);
  chrome.permissions.onRemoved.addListener(syncContentScriptRegistration);

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
  let _broadcastTabChangeTimer: ReturnType<typeof setTimeout> | null = null;
  function broadcastTabChange() {
    if (_broadcastTabChangeTimer) {
      clearTimeout(_broadcastTabChangeTimer);
    }
    _broadcastTabChangeTimer = setTimeout(() => {
      _broadcastTabChangeTimer = null;
      chrome.runtime.sendMessage({ type: "TABS_CHANGED" } as ExtensionMessage).catch(() => {});
    }, 100);
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
    if (message.type === "OPEN_TAB") {
      chrome.tabs.create({ url: message.url }).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (message.type === "SEARCH_BOOKMARKS") {
      // Content scripts can't make cross-origin fetch calls; proxy through background.
      interface SessionAuthBlob {
        accessToken?: string | null;
      }

      interface LocalAuthBlob {
        state?: {
          accessToken?: string | null;
          refreshToken?: string | null;
          serverUrl?: string;
          user?: object | null;
        };
        version?: number;
      }

      const handleSearch = async () => {
        const [sessionResult, localResult] = await Promise.all([
          chrome.storage.session.get("tabslate-auth-token"),
          chrome.storage.local.get("tabslate-auth"),
        ]);

        const sessionRaw = sessionResult["tabslate-auth-token"];
        const localRaw = localResult["tabslate-auth"];
        if (typeof localRaw !== "string") {
          sendResponse({ ok: false, bookmarks: [] });
          return;
        }

        let localBlob: LocalAuthBlob;
        try {
          localBlob = JSON.parse(localRaw) as LocalAuthBlob;
        } catch {
          sendResponse({ ok: false, bookmarks: [] });
          return;
        }

        const serverUrl = localBlob.state?.serverUrl ?? null;
        if (!serverUrl) {
          sendResponse({ ok: false, bookmarks: [] });
          return;
        }

        let accessToken: string | null = null;

        if (typeof sessionRaw === "string") {
          try {
            const sessionBlob = JSON.parse(sessionRaw) as SessionAuthBlob;
            accessToken = sessionBlob.accessToken ?? null;
          } catch {
            accessToken = null;
          }
        }

        if (!accessToken) {
          const legacyAccessToken =
            typeof localBlob.state?.accessToken === "string"
              ? localBlob.state.accessToken
              : null;

          if (legacyAccessToken) {
            accessToken = legacyAccessToken;

            if (localBlob.state) {
              delete localBlob.state.accessToken;
            }

            await Promise.all([
              chrome.storage.session.set({
                "tabslate-auth-token": JSON.stringify({ accessToken: legacyAccessToken }),
              }),
              chrome.storage.local.set({
                "tabslate-auth": JSON.stringify(localBlob),
              }),
            ]);
          }
        }

        if (!accessToken) {
          // No session token available — the newtab auth store's silentRefresh
          // will rehydrate the session shortly. Return empty results so the
          // overlay degrades gracefully rather than racing on the refresh token.
          sendResponse({ ok: false, bookmarks: [] });
          return;
        }

        try {
          const result = await searchBookmarks(serverUrl, accessToken, message.query);
          sendResponse({ ok: true, bookmarks: result.bookmarks });
        } catch {
          sendResponse({ ok: false, bookmarks: [] });
        }
      };

      void handleSearch().catch(() => sendResponse({ ok: false, bookmarks: [] }));
      return true; // keep channel open for async response
    }
  });
});
