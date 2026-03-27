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
export function getCurrentWindowGroups(): Promise<BrowserTabGroup[]> {
  return new Promise((resolve) => {
    chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT }, (groups) => {
      resolve(groups.map(toGroup));
    });
  });
}

/** Create a new tab group from the given tab IDs */
export async function groupTabs(
  tabIds: number[],
  title: string,
  color: TabGroupColor
): Promise<number> {
  const groupId = await new Promise<number>((resolve) =>
    chrome.tabs.group({ tabIds: tabIds as [number, ...number[]] }, (id) => resolve(id!))
  );
  await new Promise<void>((resolve) =>
    chrome.tabGroups.update(groupId, { title, color }, () => resolve())
  );
  return groupId;
}

/** Update an existing group's metadata */
export function updateGroup(
  groupId: number,
  patch: { title?: string; color?: TabGroupColor; collapsed?: boolean }
): Promise<BrowserTabGroup> {
  return new Promise((resolve, reject) =>
    chrome.tabGroups.update(groupId, patch, (g) => {
      if (g) resolve(toGroup(g));
      else reject(new Error("Failed to update group"));
    })
  );
}

/** Remove all tabs in this group from the group (ungroup) */
export function ungroupTabs(tabIds: number[]): Promise<void> {
  return new Promise((resolve) => chrome.tabs.ungroup(tabIds as [number, ...number[]], () => resolve()));
}

/**
 * Open a list of URLs as new tabs and immediately put them in a named,
 * colored tab group. Returns the new group ID.
 */
export async function openAsTabGroup(
  urls: string[],
  title: string,
  color: TabGroupColor
): Promise<number> {
  if (urls.length === 0) throw new Error("No URLs to open");

  const tabIds: number[] = [];
  for (const url of urls) {
    const tab = await new Promise<chrome.tabs.Tab>((resolve) =>
      chrome.tabs.create({ url, active: false }, resolve)
    );
    if (tab.id) tabIds.push(tab.id);
  }

  return groupTabs(tabIds, title, color);
}
