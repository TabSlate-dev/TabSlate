import type { Bookmark, Collection, Tag, Workspace } from "@/lib/types";

export function makeWorkspace(id: string, overrides: Partial<Workspace> = {}): Workspace {
  return { id, name: id, color: "blue", position: 0, seq: 0, ...overrides };
}

export function makeCollection(id: string, workspaceId: string, overrides: Partial<Collection> = {}): Collection {
  return { id, workspaceId, name: id, icon: "folder", position: 0, seq: 0, ...overrides };
}

export function makeTag(id: string, name: string, overrides: Partial<Tag> = {}): Tag {
  return { id, name, color: "bg-blue-500/10 text-blue-500", seq: 0, ...overrides };
}

export function makeBookmark(id: string, overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id,
    title: id,
    url: `https://example.com/${id}`,
    description: "",
    favicon: "",
    collectionId: "",
    tags: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    isFavorite: false,
    seq: 0,
    ...overrides,
  };
}

export function bookmarkMap(bookmarks: readonly Bookmark[]): Map<string, Bookmark> {
  return new Map(bookmarks.map((bookmark) => [bookmark.id, bookmark]));
}

/** Store setup only: the per-collection counts the bookmarks store keeps alongside its map. */
export function countsByCollection(bookmarks: readonly Bookmark[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const bookmark of bookmarks) {
    counts[bookmark.collectionId] = (counts[bookmark.collectionId] ?? 0) + 1;
  }
  return counts;
}
