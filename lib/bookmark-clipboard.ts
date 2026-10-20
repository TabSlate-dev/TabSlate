import type { Bookmark } from "@/lib/types";

/** One URL per line. */
export function formatLinkList(bookmarks: readonly Pick<Bookmark, "url">[]): string {
  return bookmarks.map((bookmark) => bookmark.url).join("\n");
}

function escapeLinkText(title: string): string {
  return title.replace(/[\\[\]]/g, (character) => `\\${character}`).replace(/\r\n|\r|\n/g, " ");
}

function escapeLinkTarget(url: string): string {
  return url.replace(/[ ()]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** One `- [title](url)` line per bookmark, safe to paste into Markdown. */
export function formatMarkdownLinkList(bookmarks: readonly Pick<Bookmark, "title" | "url">[]): string {
  return bookmarks
    .map((bookmark) => `- [${escapeLinkText(bookmark.title)}](${escapeLinkTarget(bookmark.url)})`)
    .join("\n");
}
