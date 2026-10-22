import { MAX_TAG_NAME_LENGTH, normalizeTagName, tagNameError } from "@/lib/tag-name";
import { buildTagTree, tagAncestors, tagDescendants } from "@/lib/tag-tree";
import type { TagTree, TagValidationError } from "@/lib/tag-tree";
import type { Tag } from "@/lib/types";

export interface TagMutationPlan {
  upserts: Tag[];
  tombstones: Tag[];
  replacements: ReadonlyMap<string, string>;
}

export type TagActionResult = { ok: true; tagId?: string } | { ok: false; error: TagValidationError | "quota" | "stale" | "storage" };

export type TagMutationPlanResult = { ok: true; plan: TagMutationPlan } | { ok: false; error: TagValidationError };

function emptyPlan(): TagMutationPlan {
  return { upserts: [], tombstones: [], replacements: new Map() };
}

function targetStructureError(tree: TagTree, sourceId: string, targetId: string | undefined, operation: "move" | "merge"): TagValidationError | null {
  if (!tree.tagsById.has(sourceId)) {
    return "missing";
  }
  if (targetId === undefined) {
    return operation === "merge" ? "invalid_parent" : null;
  }
  if (!tree.tagsById.has(targetId)) {
    return "invalid_parent";
  }
  return tagDescendants(tree, sourceId).has(targetId) ? "cycle" : null;
}

function moveDepthError(tree: TagTree, sourceId: string, targetId: string | undefined): TagValidationError | null {
  const sourceDepth = tagAncestors(tree, sourceId).length;
  const parentDepth = targetId === undefined ? 0 : tagAncestors(tree, targetId).length + 1;
  for (const id of tagDescendants(tree, sourceId)) {
    if (parentDepth + tagAncestors(tree, id).length - sourceDepth + 1 > 5) {
      return "depth";
    }
  }
  return null;
}

/** Coalesce in the simulated graph so later siblings see earlier moves. */
function mergePlan(tree: TagTree, sourceId: string, targetId: string, now: number): TagMutationPlan {
  const records = new Map(tree.tagsById);
  const parents = new Map(tree.parentById);
  const upserts = new Map<string, Tag>();
  const tombstones: Tag[] = [];
  const replacements = new Map<string, string>();
  const pending: [string, string][] = [[sourceId, targetId]];
  while (pending.length > 0) {
    const pair = pending.pop();
    if (!pair) {
      continue;
    }
    const [source, target] = pair;
    const tag = records.get(source);
    if (!tag) {
      continue;
    }
    records.delete(source);
    parents.delete(source);
    upserts.delete(source);
    tombstones.push({ ...tag, seq: 0, deletedAt: now });
    replacements.set(source, target);
    const coalescing: [string, string][] = [];
    const childIds = [...parents].filter(([, parent]) => parent === source).map(([id]) => id).sort();
    for (const childId of childIds) {
      const child = records.get(childId);
      if (!child) {
        continue;
      }
      const matchingId = [...parents].filter(([id, parent]) => id !== childId && parent === target).map(([id]) => id).sort()
        .find(id => normalizeTagName(records.get(id)?.name ?? "") === normalizeTagName(child.name));
      if (matchingId !== undefined) {
        coalescing.push([childId, matchingId]);
        continue;
      }
      const moved = { ...child, parentId: target, seq: 0 };
      records.set(childId, moved);
      parents.set(childId, target);
      upserts.set(childId, moved);
    }
    pending.push(...coalescing.reverse());
  }
  return { upserts: [...upserts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, tag]) => tag), tombstones, replacements };
}

function mergeDepthError(tree: TagTree, targetId: string, plan: TagMutationPlan): TagValidationError | null {
  const removed = new Set(plan.tombstones.map(tag => tag.id));
  const changed = new Map(plan.upserts.map(tag => [tag.id, tag]));
  const records = new Map([...tree.tagsById].filter(([id]) => !removed.has(id)));
  for (const tag of plan.upserts) {
    records.set(tag.id, tag);
  }
  // Preserve view-only repairs when simulating edges, including corrupt legacy cycles.
  const simulated = buildTagTree([...records.values()].map(tag => ({ ...tag, parentId: changed.has(tag.id) ? tag.parentId : tree.parentById.get(tag.id) })), tree.locale);
  for (const id of tagDescendants(simulated, targetId)) {
    if (tagAncestors(simulated, id).length + 1 > 5) {
      return "depth";
    }
  }
  return null;
}

export function tagTargetError(tree: TagTree, sourceId: string, targetId: string | undefined, operation: "move" | "merge"): TagValidationError | null {
  const error = targetStructureError(tree, sourceId, targetId, operation);
  if (error) {
    return error;
  }
  if (operation === "merge" && targetId !== undefined) {
    return mergeDepthError(tree, targetId, mergePlan(tree, sourceId, targetId, 0));
  }
  const source = tree.tagsById.get(sourceId);
  if (source && (tree.childrenByParent.get(targetId) ?? []).some(id => id !== sourceId && normalizeTagName(tree.tagsById.get(id)?.name ?? "") === normalizeTagName(source.name))) {
    return "duplicate";
  }
  return moveDepthError(tree, sourceId, targetId);
}

export function planTagEdit(tree: TagTree, id: string, patch: Partial<Pick<Tag, "name" | "color" | "parentId">>): TagMutationPlanResult {
  const tag = tree.tagsById.get(id);
  if (!tag) {
    return { ok: false, error: "missing" };
  }
  const name = patch.name === undefined ? tag.name : patch.name.trim();
  const parentChanged = Object.prototype.hasOwnProperty.call(patch, "parentId") && patch.parentId !== tag.parentId;
  const parentId = parentChanged ? patch.parentId : tree.parentById.get(id);
  if (name !== tag.name) {
    const error = tagNameError(name, []);
    if (error) {
      return { ok: false, error };
    }
  }
  if (parentChanged) {
    const error = targetStructureError(tree, id, parentId, "move") ?? moveDepthError(tree, id, parentId);
    if (error) {
      return { ok: false, error };
    }
  }
  if ((name !== tag.name || parentChanged) && (tree.childrenByParent.get(parentId) ?? []).some(sibling => sibling !== id && normalizeTagName(tree.tagsById.get(sibling)?.name ?? "") === normalizeTagName(name))) {
    return { ok: false, error: "duplicate" };
  }
  const color = patch.color ?? tag.color;
  if (name === tag.name && color === tag.color && !parentChanged) {
    return { ok: true, plan: emptyPlan() };
  }
  const updated = { ...tag, name, color, seq: 0, ...(parentChanged ? { parentId } : {}) };
  return { ok: true, plan: { ...emptyPlan(), upserts: [updated] } };
}

export function planTagDeletion(tree: TagTree, ids: readonly string[], now: number): TagMutationPlanResult {
  const removed = new Set(ids);
  if (ids.some(id => !tree.tagsById.has(id))) {
    return { ok: false, error: "missing" };
  }
  const plan = emptyPlan();
  const promoted = new Map<string, string | undefined>();
  const reserved = new Map<string | undefined, Set<string>>();
  for (const [id, tag] of tree.tagsById) {
    if (removed.has(id)) {
      continue;
    }
    let parent = tree.parentById.get(id);
    if (parent !== undefined && removed.has(parent)) {
      while (parent !== undefined && removed.has(parent)) {
        parent = tree.parentById.get(parent);
      }
      promoted.set(id, parent);
      continue;
    }
    const names = reserved.get(parent) ?? new Set<string>();
    names.add(normalizeTagName(tag.name));
    reserved.set(parent, names);
  }
  for (const id of [...promoted.keys()].sort()) {
    const tag = tree.tagsById.get(id);
    if (!tag) {
      continue;
    }
    const parentId = promoted.get(id);
    const names = reserved.get(parentId) ?? new Set<string>();
    let name = tag.name;
    let suffix = 2;
    while (names.has(normalizeTagName(name))) {
      const ending = ` (${suffix++})`;
      name = Array.from(tag.name.trim()).slice(0, MAX_TAG_NAME_LENGTH - Array.from(ending).length).join("") + ending;
    }
    names.add(normalizeTagName(name));
    reserved.set(parentId, names);
    plan.upserts.push({ ...tag, name, parentId, seq: 0 });
  }
  for (const id of [...removed].sort()) {
    const tag = tree.tagsById.get(id);
    if (tag) {
      plan.tombstones.push({ ...tag, seq: 0, deletedAt: now });
    }
  }
  return { ok: true, plan };
}

export function planTagMerge(tree: TagTree, sourceId: string, targetId: string, now: number): TagMutationPlanResult {
  const error = targetStructureError(tree, sourceId, targetId, "merge");
  if (error) {
    return { ok: false, error };
  }
  const plan = mergePlan(tree, sourceId, targetId, now);
  const depthError = mergeDepthError(tree, targetId, plan);
  return depthError ? { ok: false, error: depthError } : { ok: true, plan };
}
