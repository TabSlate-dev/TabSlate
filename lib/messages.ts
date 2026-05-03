import type { Bookmark } from "@/lib/types";

export type ExtensionMessage =
  | { type: "ADD_BOOKMARK"; data: Omit<Bookmark, "id" | "createdAt" | "isFavorite"> }
  | { type: "BOOKMARKS_CHANGED" }
  | { type: "WORKSPACE_CHANGED" }
  | { type: "TABS_CHANGED" };
