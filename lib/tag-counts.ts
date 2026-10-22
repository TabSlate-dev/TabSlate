import { tagAncestors, type TagTree } from "@/lib/tag-tree";
import type { Bookmark } from "@/lib/types";

/** A bookmark contributes once to each directly assigned tag and its ancestors. */
export function countTagUsage(tree: TagTree, bookmarks: readonly Bookmark[]): Map<string, number> {
  const counts = new Map([...tree.tagsById.keys()].map(id => [id, 0]));
  for (const bookmark of bookmarks) {
    const used = new Set<string>();
    for (const id of bookmark.tags) {
      if (!tree.tagsById.has(id)) { continue; }
      used.add(id);
      for (const ancestor of tagAncestors(tree, id)) { used.add(ancestor); }
    }
    for (const id of used) { counts.set(id, (counts.get(id) ?? 0) + 1); }
  }
  return counts;
}

export function unusedTagIds(tree: TagTree, bookmarks: readonly Bookmark[]): Set<string> {
  return new Set([...countTagUsage(tree, bookmarks)].filter(([, count]) => count === 0).map(([id]) => id));
}
