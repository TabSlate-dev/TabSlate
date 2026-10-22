import { normalizeTagName, tagNameError } from "@/lib/tag-name";
import type { Tag } from "@/lib/types";

export type TagValidationError = "empty" | "empty_segment" | "duplicate" | "slash" | "too_long" | "depth" | "invalid_parent" | "cycle" | "missing";

export interface TagTree {
  tagsById: ReadonlyMap<string, Tag>;
  parentById: ReadonlyMap<string, string | undefined>;
  childrenByParent: ReadonlyMap<string | undefined, readonly string[]>;
  roots: readonly string[];
  locale: string;
}

export type TagPathResult = { ok: true; leaf: Tag; created: Tag[] } | { ok: false; error: TagValidationError };

/** Repairs only the displayed edges, preserving the stored records for sync. */
export function buildTagTree(tags: readonly Tag[], locale: string): TagTree {
  const tagsById = new Map(tags.filter(tag => tag.deletedAt === undefined).map(tag => [tag.id, tag]));
  const parentById = new Map<string, string | undefined>();
  for (const tag of tagsById.values()) {
    parentById.set(tag.id, tag.parentId !== undefined && tagsById.has(tag.parentId) ? tag.parentId : undefined);
  }

  const visited = new Set<string>();
  for (const id of tagsById.keys()) {
    const path: string[] = [];
    const positions = new Map<string, number>();
    let current: string | undefined = id;
    while (current !== undefined && !visited.has(current)) {
      const cycleStart = positions.get(current);
      if (cycleStart !== undefined) {
        const detached = path.slice(cycleStart).sort()[0];
        if (detached !== undefined) {
          parentById.set(detached, undefined);
        }
        break;
      }
      positions.set(current, path.length);
      path.push(current);
      current = parentById.get(current);
    }
    for (const entry of path) {
      visited.add(entry);
    }
  }

  const childrenByParent = new Map<string | undefined, string[]>();
  for (const [id, parent] of parentById) {
    const children = childrenByParent.get(parent) ?? [];
    children.push(id);
    childrenByParent.set(parent, children);
  }
  const collator = new Intl.Collator(locale, { sensitivity: "base" });
  for (const children of childrenByParent.values()) {
    children.sort((a, b) => collator.compare(tagsById.get(a)?.name ?? "", tagsById.get(b)?.name ?? "") || (a < b ? -1 : a > b ? 1 : 0));
  }
  return { tagsById, parentById, childrenByParent, roots: childrenByParent.get(undefined) ?? [], locale };
}

/** Ancestors in root-to-parent order, excluding the tag itself. */
export function tagAncestors(tree: TagTree, id: string): string[] {
  const ancestors: string[] = [];
  let parent = tree.parentById.get(id);
  while (parent !== undefined) {
    ancestors.push(parent);
    parent = tree.parentById.get(parent);
  }
  return ancestors.reverse();
}

export function tagDescendants(tree: TagTree, id: string): Set<string> {
  const descendants = new Set<string>();
  const pending = tree.tagsById.has(id) ? [id] : [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || descendants.has(current)) {
      continue;
    }
    descendants.add(current);
    pending.push(...(tree.childrenByParent.get(current) ?? []).slice().reverse());
  }
  return descendants;
}

export function tagPath(tree: TagTree, id: string): Tag[] {
  if (!tree.tagsById.has(id)) {
    return [];
  }
  return [...tagAncestors(tree, id), id].flatMap(entry => {
    const tag = tree.tagsById.get(entry);
    return tag ? [tag] : [];
  });
}

export function displayTagPath(tree: TagTree, id: string): string {
  return tagPath(tree, id).map(tag => tag.name).join(" › ");
}

export function expandTagSelection(tree: TagTree, selected: readonly string[]): Set<string> {
  const expanded = new Set<string>();
  for (const id of selected) {
    for (const descendant of tagDescendants(tree, id)) {
      expanded.add(descendant);
    }
  }
  return expanded;
}

export function resolveTagPath(tree: TagTree, input: string, parentId: string | undefined, rootColor: string, newId: () => string): TagPathResult {
  if (parentId !== undefined && !tree.tagsById.has(parentId)) {
    return { ok: false, error: "invalid_parent" };
  }
  if (!input.trim()) {
    return { ok: false, error: "empty" };
  }
  const segments = input.split("/").map(segment => segment.trim());
  if (segments.some(segment => !segment)) {
    return { ok: false, error: "empty_segment" };
  }
  for (const segment of segments) {
    const error = tagNameError(segment, []);
    if (error) {
      return { ok: false, error };
    }
  }
  const parentDepth = parentId === undefined ? 0 : tagAncestors(tree, parentId).length + 1;
  if (parentDepth + segments.length > 5) {
    return { ok: false, error: "depth" };
  }

  const created: Tag[] = [];
  let parent = parentId === undefined ? undefined : tree.tagsById.get(parentId);
  let leaf: Tag | undefined;
  for (const name of segments) {
    const siblingIds = tree.childrenByParent.get(parent?.id) ?? [];
    leaf = siblingIds.map(id => tree.tagsById.get(id)).find(tag => tag !== undefined && normalizeTagName(tag.name) === normalizeTagName(name));
    if (!leaf) {
      leaf = { id: newId(), name, parentId: parent?.id, color: parent?.color ?? rootColor, seq: 0 };
      created.push(leaf);
    }
    parent = leaf;
  }
  return leaf ? { ok: true, leaf, created } : { ok: false, error: "empty" };
}
