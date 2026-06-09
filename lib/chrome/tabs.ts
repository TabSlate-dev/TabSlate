/**
 * Chrome tabs API utilities
 */

export interface BrowserTab {
  id: number;
  title: string;
  url: string;
  favIconUrl: string;
  windowId: number;
  active: boolean;
  index: number;
  /** -1 (chrome.tabs.TAB_ID_NONE) means not in any group */
  groupId: number;
}

/** Exclude internal browser pages */
function isUserTab(tab: chrome.tabs.Tab): boolean {
  return (
    !!tab.url &&
    !tab.url.startsWith("chrome://") &&
    !tab.url.startsWith("chrome-extension://") &&
    !tab.url.startsWith("about:") &&
    !tab.url.startsWith("edge://")
  );
}

function toTab(tab: chrome.tabs.Tab): BrowserTab {
  return {
    id: tab.id ?? 0,
    title: tab.title ?? tab.url ?? "Untitled",
    url: tab.url ?? "",
    favIconUrl: tab.favIconUrl ?? "",
    windowId: tab.windowId,
    active: tab.active,
    index: tab.index,
    groupId: tab.groupId ?? -1,
  };
}

/** Get all user-navigable tabs in the current window */
export function getCurrentWindowTabs(): Promise<BrowserTab[]> {
  return new Promise((resolve) => {
    chrome.tabs.query({ currentWindow: true }, (tabs) => {
      resolve(tabs.filter(isUserTab).map(toTab));
    });
  });
}

/** Get all user-navigable tabs across all windows */
export function getAllTabs(): Promise<BrowserTab[]> {
  return new Promise((resolve) => {
    chrome.tabs.query({}, (tabs) => {
      resolve(tabs.filter(isUserTab).map(toTab));
    });
  });
}

/** Open a list of URLs as new tabs in a new window */
export async function openUrlsInNewWindow(urls: string[]): Promise<void> {
  if (urls.length === 0) { return; }
  const [first, ...rest] = urls;
  const win = await new Promise<chrome.windows.Window>((resolve) =>
    chrome.windows.create({ url: first }, (w) => resolve(w!))
  );
  for (const url of rest) {
    await new Promise<void>((resolve) =>
      chrome.tabs.create({ windowId: win.id!, url }, () => resolve())
    );
  }
}

/** Open a list of URLs as new tabs in the current window */
export async function openUrls(urls: string[]): Promise<void> {
  for (const url of urls) {
    await new Promise<void>((resolve) =>
      chrome.tabs.create({ url }, () => resolve())
    );
  }
}

/** Close a tab by id */
export function closeTab(tabId: number): Promise<void> {
  return new Promise((resolve) => chrome.tabs.remove(tabId, resolve));
}

/** Switch focus to a tab */
export function focusTab(tabId: number, windowId: number): Promise<void> {
  return new Promise((resolve) => {
    chrome.windows.update(windowId, { focused: true }, () => {
      chrome.tabs.update(tabId, { active: true }, () => resolve());
    });
  });
}

/** 
 * Open a URL smartly:
 * 1. If it's already open in any tab across any window, switch to it.
 * 2. Otherwise, update the current tab to this URL.
 */
export async function smartOpenUrl(url: string): Promise<void> {
  const normalized = url.toLowerCase().replace(/\/$/, "");
  const tabs = await getAllTabs();
  const existing = tabs.find((t) => t.url.toLowerCase().replace(/\/$/, "") === normalized);

  if (existing) {
    await focusTab(existing.id, existing.windowId);
  } else {
    window.location.href = url;
  }
}
