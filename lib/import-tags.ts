import { generateId } from "./id";
import type { ImportPlan, ImportTagOptions } from "./import-types";
import { MAX_TAG_NAME_LENGTH, normalizeTagName } from "./tag-name";
import type { Tag } from "./types";

const DEFAULT_TAG_COLOR = "bg-blue-500/10 text-blue-500";

function truncateWithSuffix(baseName: string, suffix?: number): string {
  if (suffix === undefined) {
    return Array.from(baseName).slice(0, MAX_TAG_NAME_LENGTH).join("");
  }
  const ending = ` (${suffix})`;
  return Array.from(baseName).slice(0, MAX_TAG_NAME_LENGTH - Array.from(ending).length).join("") + ending;
}

export function normalizeImportSegment(raw: string, untitled = "Untitled"): string {
  const trimmed = raw.trim().replaceAll("/", "／");
  return trimmed.length === 0 ? untitled : trimmed;
}

interface TagTreeNode {
  tag: Omit<Tag, "seq">;
  children: Map<string, TagTreeNode>; // key: normalizeTagName(originalRawName)
  usedNames: Set<string>; // normalizeTagName(allocatedName)
}

export function addImportTags(
  plan: ImportPlan,
  source: "chrome" | "toby",
  pathsByBookmarkId: ReadonlyMap<string, readonly string[]>,
  options: ImportTagOptions,
): ImportPlan {
  if (!options.enabled) {
    return plan;
  }

  if (plan.bookmarks.length === 0) {
    return {
      ...plan,
      provenance: {
        mode: "none",
        requestedTagCount: 0,
      },
    };
  }

  // 1. Allocate unique root against existing top-level tags and any current plan top-level tags
  const rootBase = normalizeImportSegment(options.rootName, "Untitled");
  const existingTopLevelNames = new Set(
    options.existingTags
      .filter((t) => t.parentId === undefined)
      .map((t) => normalizeTagName(t.name)),
  );
  for (const t of plan.tags) {
    if (t.parentId === undefined) {
      existingTopLevelNames.add(normalizeTagName(t.name));
    }
  }

  let rootName = truncateWithSuffix(rootBase);
  let rootSuffix = 2;
  while (existingTopLevelNames.has(normalizeTagName(rootName))) {
    rootName = truncateWithSuffix(rootBase, rootSuffix++);
  }

  const rootTagId = generateId();
  const rootTag: Omit<Tag, "seq"> = {
    id: rootTagId,
    name: rootName,
    color: DEFAULT_TAG_COLOR,
    parentId: undefined,
  };

  const rootNode: TagTreeNode = {
    tag: rootTag,
    children: new Map(),
    usedNames: new Set(),
  };

  // 2. Build the desired tree of provenance tags for accepted bookmarks
  const collectionById = new Map(plan.collections.map((c) => [c.id, c]));
  const leafByBookmarkId = new Map<string, string>();

  for (const bm of plan.bookmarks) {
    let desiredSegments: string[];
    if (source === "chrome") {
      const col = collectionById.get(bm.collectionId);
      const colName = col?.name ?? "Untitled";
      const folders = pathsByBookmarkId.get(bm.id) ?? [];
      // Chrome tag levels: root + allocated collection name + at most 3 lower folders (max depth 5)
      desiredSegments = [colName, ...folders.slice(0, 3)];
    } else {
      desiredSegments = [...(pathsByBookmarkId.get(bm.id) ?? [])];
    }

    let currentNode = rootNode;
    for (const segment of desiredSegments) {
      const originalKey = normalizeTagName(segment);
      let childNode = currentNode.children.get(originalKey);
      if (!childNode) {
        const base = normalizeImportSegment(segment, "Untitled");
        let allocatedName = truncateWithSuffix(base);
        let suffix = 2;
        while (currentNode.usedNames.has(normalizeTagName(allocatedName))) {
          allocatedName = truncateWithSuffix(base, suffix++);
        }
        currentNode.usedNames.add(normalizeTagName(allocatedName));

        const childTag: Omit<Tag, "seq"> = {
          id: generateId(),
          name: allocatedName,
          color: currentNode.tag.color,
          parentId: currentNode.tag.id,
        };

        childNode = {
          tag: childTag,
          children: new Map(),
          usedNames: new Set(),
        };
        currentNode.children.set(originalKey, childNode);
      }
      currentNode = childNode;
    }

    leafByBookmarkId.set(bm.id, currentNode.tag.id);
  }

  // 3. Collect all desired optional tags
  const desiredTags: Omit<Tag, "seq">[] = [];
  function collectNodes(node: TagTreeNode) {
    desiredTags.push(node.tag);
    for (const child of node.children.values()) {
      collectNodes(child);
    }
  }
  collectNodes(rootNode);

  const requestedTagCount = desiredTags.length;
  const available = options.availableTags;

  let mode: "full" | "root-only" | "none";
  let tagsToAdd: Omit<Tag, "seq">[];
  let updatedBookmarks: Omit<import("./types").Bookmark, "seq">[];

  if (available === -1 || requestedTagCount <= available) {
    mode = "full";
    tagsToAdd = desiredTags;
    updatedBookmarks = plan.bookmarks.map((bm) => {
      const leafId = leafByBookmarkId.get(bm.id) ?? rootTagId;
      return {
        ...bm,
        tags: [...bm.tags, leafId],
      };
    });
  } else if (available >= 1) {
    mode = "root-only";
    tagsToAdd = [rootTag];
    updatedBookmarks = plan.bookmarks.map((bm) => ({
      ...bm,
      tags: [...bm.tags, rootTagId],
    }));
  } else {
    mode = "none";
    tagsToAdd = [];
    updatedBookmarks = plan.bookmarks;
  }

  return {
    ...plan,
    tags: [...plan.tags, ...tagsToAdd],
    bookmarks: updatedBookmarks,
    provenance: {
      rootTagId: mode !== "none" ? rootTagId : undefined,
      mode,
      requestedTagCount,
    },
  };
}
