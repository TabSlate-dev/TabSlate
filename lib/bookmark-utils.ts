import type { Bookmark } from "@/lib/types";

/** Replace data: favicon URLs (large base64 blobs from chrome.tabs) with a lightweight domain-derived URL. */
export function normalizeFavicon(favicon: string | undefined, url: string): string {
  if (!favicon || favicon.startsWith("data:")) {
    try {
      const domain = new URL(url).hostname;
      return `https://icons.duckduckgo.com/ip3/${domain}.ico`;
    } catch {
      return "";
    }
  }
  return favicon;
}

/** Remove trailing slash and lowercase for URL comparison. */
export function normalizeUrl(url: string): string {
  return url.toLowerCase().replace(/\/$/, "");
}

/** Returns the first existing bookmark whose URL matches, or undefined. */
export function findDuplicateBookmark(
  bookmarks: Bookmark[],
  url: string
): Bookmark | undefined {
  const normalized = normalizeUrl(url);
  return bookmarks.find((b) => b?.url && normalizeUrl(b.url) === normalized);
}

/** 
 * Returns a Set of normalized URLs for all existing bookmarks. 
 * Optimized for batch deduplication.
 */
export function getNormalizedUrlSet(bookmarks: Bookmark[]): Set<string> {
  return new Set(
    bookmarks
      .filter((b) => !!b.url)
      .map((b) => normalizeUrl(b.url))
  );
}

/**
 * Read a bookmark's creation time as a number.
 *
 * Locally created bookmarks store an ISO string, but records merged from the
 * server were stored as the raw epoch stringified, which `new Date()` parses as
 * an invalid date. A comparator that returns NaN is inconsistent, and V8's sort
 * then yields an order that depends on the array's starting order — which is
 * why lists reshuffled on every reload. Accept both shapes so already-stored
 * records sort correctly too.
 */
export function bookmarkCreatedAtTime(createdAt: string): number {
  const parsed = new Date(createdAt).getTime();
  if (!Number.isNaN(parsed)) { return parsed; }
  const epoch = Number(createdAt);
  return Number.isFinite(epoch) ? epoch : 0;
}

/**
 * Newest first, breaking ties by id.
 *
 * Bookmarks saved in one batch share a timestamp, so the tiebreaker is what
 * keeps the order stable across reloads.
 */
export function compareBookmarksNewestFirst(a: Bookmark, b: Bookmark): number {
  return bookmarkCreatedAtTime(b.createdAt) - bookmarkCreatedAtTime(a.createdAt)
    || a.id.localeCompare(b.id);
}

/** Most recently trashed first, falling back to creation time when unset. */
export function compareBookmarksTrashedFirst(a: Bookmark, b: Bookmark): number {
  return (b.deletedAt ?? 0) - (a.deletedAt ?? 0) || compareBookmarksNewestFirst(a, b);
}
