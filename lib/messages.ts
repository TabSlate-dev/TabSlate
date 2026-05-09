import type { Bookmark } from "@/lib/types";

export type ExtensionMessage =
  | { type: "ADD_BOOKMARK"; data: Omit<Bookmark, "id" | "createdAt" | "isFavorite"> }
  | { type: "BOOKMARKS_CHANGED" }
  | { type: "WORKSPACE_CHANGED" }
  | { type: "TABS_CHANGED" }
  | { type: "OPEN_SEARCH" }
  | { type: "GET_OPEN_TABS" }
  | { type: "FOCUS_TAB"; tabId: number; windowId: number }
  | { type: "OPEN_TAB"; url: string }
  | { type: "SEARCH_BOOKMARKS"; query: string; accessToken: string; serverUrl: string };
