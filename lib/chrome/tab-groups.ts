/**
 * Chrome Tab Groups API utilities (requires "tabGroups" permission)
 * https://developer.chrome.com/docs/extensions/reference/api/tabGroups
 */

export type TabGroupColor =
  | "grey"
  | "blue"
  | "red"
  | "yellow"
  | "green"
  | "pink"
  | "purple"
  | "cyan"
  | "orange";

export interface BrowserTabGroup {
  id: number;
  title: string;
  color: TabGroupColor;
  collapsed: boolean;
  windowId: number;
}

/** Chrome's actual tab group colors (matches Chrome UI) */
export const TAB_GROUP_COLORS: Record<TabGroupColor, string> = {
  grey:   "#dadce0",
  blue:   "#4285f4",
  red:    "#d93025",
  yellow: "#f29900",
  green:  "#188038",
  pink:   "#e52592",
  purple: "#a142f4",
  cyan:   "#007b83",
  orange: "#e8710a",
};

export const TAB_GROUP_COLOR_KEYS = Object.keys(TAB_GROUP_COLORS) as TabGroupColor[];

function toTabIdTuple(tabIds: number[]): [number, ...number[]] {
  const [firstTabId, ...restTabIds] = tabIds;
  if (firstTabId === undefined) {
    throw new Error("At least one tab ID is required");
  }

  return [firstTabId, ...restTabIds];
}

function toGroup(g: chrome.tabGroups.TabGroup): BrowserTabGroup {
  return {
    id: g.id,
    title: g.title ?? "",
    color: (g.color as TabGroupColor) ?? "grey",
    collapsed: g.collapsed,
    windowId: g.windowId,
  };
}

/** Get all tab groups in the current window */
export async function getCurrentWindowGroups(): Promise<BrowserTabGroup[]> {
  const groups = await chrome.tabGroups.query({
    windowId: chrome.windows.WINDOW_ID_CURRENT,
  });
  return groups.map(toGroup);
}

/** Create a new tab group from the given tab IDs */
export async function groupTabs(
  tabIds: number[],
  title: string,
  color: TabGroupColor
): Promise<number> {
  const groupId = await chrome.tabs.group({ tabIds: toTabIdTuple(tabIds) });
  await chrome.tabGroups.update(groupId, { title, color });
  return groupId;
}

/** Update an existing group's metadata */
export function updateGroup(
  groupId: number,
  patch: { title?: string; color?: TabGroupColor; collapsed?: boolean }
): Promise<BrowserTabGroup> {
  return chrome.tabGroups.update(groupId, patch).then((group) => {
    if (!group) {
      throw new Error("Failed to update group");
    }

    return toGroup(group);
  });
}

/** Remove all tabs in this group from the group (ungroup) */
export async function ungroupTabs(tabIds: number[]): Promise<void> {
  await chrome.tabs.ungroup(toTabIdTuple(tabIds));
}

/** A group opened from URLs, and how many of them the browser refused. */
export interface OpenedTabGroup {
  groupId: number;
  failedCount: number;
}

/**
 * Open a list of URLs as new tabs and put the ones that opened in a named,
 * colored tab group. Throws when none of them opened.
 */
export async function openAsTabGroup(
  urls: string[],
  title: string,
  color: TabGroupColor,
  isCompact?: boolean
): Promise<OpenedTabGroup> {
  if (urls.length === 0) { throw new Error("No URLs to open"); }

  // A URL the browser refuses (e.g. file: without file access) is skipped and counted.
  const tabIds: number[] = [];
  let failedCount = 0;
  for (const url of urls) {
    try {
      const tab = await chrome.tabs.create({ url, active: false });
      if (tab.id !== undefined) {
        tabIds.push(tab.id);
      }
    } catch {
      failedCount += 1;
    }
  }
  if (tabIds.length === 0) { throw new Error("No tabs opened"); }

  const chromeTitle = isCompact ? (title[0] || "") : title;
  return { groupId: await groupTabs(tabIds, chromeTitle, color), failedCount };
}
