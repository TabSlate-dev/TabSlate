import type { Bookmark, BookmarkPatchEntry } from "@/lib/types";

export type TagCheckState = "checked" | "indeterminate" | "unchecked";

/** For each tag: checked when every bookmark has it, indeterminate when some do, unchecked when none do. */
export function tagCheckStates(bookmarks: readonly Bookmark[], tagIds: readonly string[]): Map<string, TagCheckState> {
  const states = new Map<string, TagCheckState>();
  for (const tagId of tagIds) {
    const count = bookmarks.filter((bookmark) => bookmark.tags.includes(tagId)).length;
    states.set(tagId, count === 0 ? "unchecked" : count === bookmarks.length ? "checked" : "indeterminate");
  }
  return states;
}

/** A click checks an empty or mixed box (add to all) and empties a checked one (remove from all). */
export function nextTagCheckState(state: TagCheckState): TagCheckState {
  return state === "checked" ? "unchecked" : "checked";
}

/**
 * Turns the rows the user changed into per-bookmark patches: a checked row
 * adds its tag to every bookmark, an unchecked row removes it. Tags the user
 * did not touch keep each bookmark's state, and bookmarks whose tags do not
 * change get no patch.
 */
export function bulkTagPatches(
  bookmarks: readonly Bookmark[],
  changes: ReadonlyMap<string, TagCheckState>,
): BookmarkPatchEntry[] {
  const patches: BookmarkPatchEntry[] = [];
  for (const bookmark of bookmarks) {
    const tags = bookmark.tags.filter((tagId) => changes.get(tagId) !== "unchecked");
    for (const [tagId, state] of changes) {
      if (state === "checked" && !tags.includes(tagId)) {
        tags.push(tagId);
      }
    }
    const unchanged = tags.length === bookmark.tags.length && tags.every((tagId, index) => tagId === bookmark.tags[index]);
    if (!unchanged) {
      patches.push({ id: bookmark.id, patch: { tags } });
    }
  }
  return patches;
}
