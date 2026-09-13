import type { Bookmark } from "@/lib/types";

/**
 * postMessage type used by the search-overlay iframe (entrypoints/search-overlay)
 * to tell its content-script host to remove it. Sent with targetOrigin "*" since
 * the embedding page's origin is arbitrary and the payload carries no data —
 * the content script verifies event.source is its own iframe before acting on it.
 */
export const SEARCH_OVERLAY_CLOSE_MESSAGE = "tabslate-search-overlay-close";

export type ExtensionMessage =
  | { type: "ADD_BOOKMARK"; data: Omit<Bookmark, "id" | "createdAt" | "isFavorite"> }
  | { type: "BOOKMARKS_CHANGED" }
  | { type: "WORKSPACE_CHANGED" }
  | { type: "TABS_CHANGED" }
  | { type: "OPEN_SEARCH" }
  | { type: "AUTH_LOGOUT" }
  | { type: "REGISTER_SEARCH_OVERLAY_SESSION"; session: string }
  | { type: "VALIDATE_SEARCH_OVERLAY_SESSION"; session: string }
  | { type: "REVOKE_SEARCH_OVERLAY_SESSION"; session: string }
  | { type: "GET_OPEN_TABS"; session: string }
  | { type: "FOCUS_TAB"; session: string; tabId: number; windowId: number }
  | { type: "OPEN_TAB"; session: string; url: string }
  | { type: "SEARCH_BOOKMARKS"; session: string; query: string }
  | { type: "WEB_SEARCH"; session: string; query: string };
