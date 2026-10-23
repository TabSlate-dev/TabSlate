import type { Bookmark, Collection, Tag, Workspace } from "@/lib/types";
import { generateId } from "@/lib/id";
import { idbGetAll, idbGet, idbPut } from "@/lib/idb";
import { resolveActiveWorkspaceCollectionTarget } from "@/lib/workspace-visibility";
import { findVisibleDuplicates, type DuplicateMatch } from "@/lib/duplicate-lookup";
import { buildTagTree, resolveTagPath } from "@/lib/tag-tree";
import type { TagActionResult, TagMutationPlan } from "@/lib/tag-mutations";
import { commitTagMutation, TagMutationQuotaError, TagMutationStaleError } from "@/lib/tag-persistence";

export interface BookmarkInput {
  title: string;
  url: string;
  favicon: string;
  description?: string;
  notes?: string;
  imageUrl?: string;
  collectionId: string;
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Workspace data (read-only for popup)
// ---------------------------------------------------------------------------

interface WorkspaceStorageState {
  workspaces: Workspace[];
  collections: Collection[];
  tags: Tag[];
  activeWorkspaceId: string;
}

export async function getWorkspaceState(): Promise<WorkspaceStorageState> {
  const [workspaces, collections, tags, activeWsKv] = await Promise.all([
    idbGetAll<Workspace>("workspaces"),
    idbGetAll<Collection>("collections"),
    idbGetAll<Tag>("tags"),
    idbGet<{ key: string; value: string }>("kv", "activeWorkspaceId"),
  ]);
  return {
    workspaces,
    collections,
    tags: tags.filter(tag => tag.deletedAt === undefined),
    activeWorkspaceId: activeWsKv?.value ?? "",
  };
}

/**
 * Saved bookmarks that look like the given page (loose tier), for the popup's
 * notice. A failed lookup reports no duplicates so saving still works.
 */
export async function findSavedDuplicates(url: string): Promise<DuplicateMatch[]> {
  try {
    const [bookmarks, state] = await Promise.all([idbGetAll<Bookmark>("bookmarks"), getWorkspaceState()]);
    return findVisibleDuplicates(
      url,
      { bookmarks, collections: state.collections, workspaces: state.workspaces },
      "loose",
    );
  } catch (err) {
    console.warn("[TabSlate] duplicate lookup failed:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tag capacity & store-free creation
// ---------------------------------------------------------------------------

export async function readTagCapacity(): Promise<{ limit: number }> {
  try {
    if (typeof chrome === "undefined" || !chrome.storage?.local?.get) {
      return { limit: -1 };
    }
    const result = await new Promise<Record<string, unknown>>((resolve) => {
      let settled = false;
      try {
        const maybePromise: unknown = chrome.storage.local.get("tabslate-plan", (items) => {
          if (!settled) {
            settled = true;
            resolve(items ?? {});
          }
        });
        if (maybePromise && typeof (maybePromise as Promise<Record<string, unknown>>).then === "function") {
          (maybePromise as Promise<Record<string, unknown>>)
            .then((items) => {
              if (!settled) {
                settled = true;
                resolve(items ?? {});
              }
            })
            .catch(() => {
              if (!settled) {
                settled = true;
                resolve({});
              }
            });
        }
      } catch {
        if (!settled) {
          settled = true;
          resolve({});
        }
      }
    });

    const raw = result["tabslate-plan"];
    if (!raw) {
      return { limit: -1 };
    }
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const maxTags = parsed?.state?.limits?.max_tags;
    if (typeof maxTags === "number") {
      return { limit: maxTags };
    }
    return { limit: -1 };
  } catch {
    return { limit: -1 };
  }
}

export async function addTagPath(input: string, color: string): Promise<TagActionResult> {
  const { limit } = await readTagCapacity();

  const attempt = async (retryOnStale: boolean): Promise<TagActionResult> => {
    try {
      const allTags = await idbGetAll<Tag>("tags");
      const activeTags = allTags.filter((tag) => tag.deletedAt === undefined);
      const tree = buildTagTree(activeTags, "en");
      const resolved = resolveTagPath(tree, input, undefined, color, generateId);
      if (!resolved.ok) {
        return resolved;
      }
      if (resolved.created.length === 0) {
        return { ok: true, tagId: resolved.leaf.id };
      }
      if (limit !== -1 && activeTags.length + resolved.created.length > limit) {
        return { ok: false, error: "quota" };
      }
      const plan: TagMutationPlan = {
        upserts: resolved.created,
        tombstones: [],
        replacements: new Map(),
      };
      await commitTagMutation(plan, activeTags, undefined, { maxActiveTags: limit });
      return { ok: true, tagId: resolved.leaf.id };
    } catch (err) {
      if (err instanceof TagMutationQuotaError) {
        return { ok: false, error: "quota" };
      }
      if (err instanceof TagMutationStaleError) {
        if (retryOnStale) {
          return attempt(false);
        }
        return { ok: false, error: "stale" };
      }
      return { ok: false, error: "storage" };
    }
  };

  return attempt(true);
}

// ---------------------------------------------------------------------------
// Public storageService (used by popup)
// ---------------------------------------------------------------------------

export const storageService = {
  async addBookmark(input: BookmarkInput): Promise<Bookmark> {
    const state = await getWorkspaceState();
    const target = resolveActiveWorkspaceCollectionTarget(
      input.collectionId,
      state.activeWorkspaceId,
      state.workspaces,
      state.collections,
    );
    if (!target) {
      throw new Error("active Workspace Collection target is unavailable");
    }
    const newBookmark: Bookmark = {
      id: generateId(),
      title: input.title,
      url: input.url,
      favicon: input.favicon || "",
      description: input.description ?? "",
      notes: input.notes ?? "",
      imageUrl: input.imageUrl ?? "",
      collectionId: target.id,
      tags: input.tags ?? [],
      createdAt: new Date().toISOString(),
      updatedAt: Date.now(),
      isFavorite: false,
      seq: 0,
    };
    await idbPut("bookmarks", newBookmark);
    return newBookmark;
  },
  addTagPath,
};
