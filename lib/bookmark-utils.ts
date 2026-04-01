import type { Bookmark } from "@/lib/types";

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
