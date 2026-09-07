import * as React from "react";
import { bookmarksAsArray, useBookmarksStore } from "@/store/bookmarks-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { findDuplicateBookmark } from "@/lib/bookmark-utils";
import type { Collection, Workspace } from "@/lib/types";
import {
  getActiveWorkspaceCollectionIds,
  getActiveWorkspaceCollections,
  resolveActiveWorkspaceCollectionTarget,
} from "@/lib/workspace-visibility";
import { useTranslation } from "@/hooks/use-translation";

export interface DropNotification {
  text: string;
  type: "success" | "duplicate" | "unavailable";
}

interface UseTabDragDropResult {
  isDragOver: boolean;
  notification: DropNotification | null;
  highlightedBookmarkId: string | null;
  /** The label shown in the drop overlay */
  targetDropLabel: string;
  targetCollectionId: string | null;
  /** Spread these props onto the drop-zone container element */
  dropZoneProps: {
    onDragEnter: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (e: React.DragEvent) => void;
  };
}

interface WorkspaceScope {
  activeWorkspaceId: string;
  workspaces: readonly Workspace[];
  collections: readonly Collection[];
}

const DRAG_TYPE = "application/tabslate-tab";


export function useTabDragDrop(): UseTabDragDropResult {
  const { t } = useTranslation();
  const addBookmark = useBookmarksStore((state) => state.addBookmark);
  const updateBookmark = useBookmarksStore((state) => state.updateBookmark);
  const bookmarks = useBookmarksStore((state) => bookmarksAsArray(state.bookmarks));
  const selectedCollection = useBookmarksStore((state) => state.selectedCollection);
  const setSelectedCollection = useBookmarksStore((state) => state.setSelectedCollection);
  const collections = useWorkspaceStore((state) => state.collections);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const setHighlightedCollectionIds = useWorkspaceStore(
    (state) => state.setHighlightedCollectionIds,
  );

  const dragCounter = React.useRef(0);
  const [isDragOver, setIsDragOver] = React.useState(false);
  const [targetCollectionId, setTargetCollectionId] = React.useState<string | null>(null);
  const [notification, setNotification] = React.useState<DropNotification | null>(null);
  const [highlightedBookmarkId, setHighlightedBookmarkId] = React.useState<string | null>(null);

  /**
   * Resolve the Collection a drop lands in.
   *
   * `hoveredId` comes from the `data-tab-drop-collection-id` row under the
   * cursor, so hovering a specific Collection targets it directly; without one
   * we fall back to the selected Collection, then to the default. An explicit
   * target that no longer belongs to the active workspace resolves to
   * undefined so the caller can report it as unavailable rather than silently
   * saving somewhere else.
   */
  function resolveTargetCollection(
    hoveredId: string | null,
    scope: WorkspaceScope,
  ): { id: string; name: string } | undefined {
    const candidate = hoveredId ?? (selectedCollection !== "all" ? selectedCollection : null);
    // "" is the uncategorized sentinel — it has no Collection to resolve.
    if (candidate) {
      const collection = resolveActiveWorkspaceCollectionTarget(
        candidate,
        scope.activeWorkspaceId,
        scope.workspaces,
        scope.collections,
      );
      return collection ? { id: collection.id, name: collection.name } : undefined;
    }
    const activeCollections = getActiveWorkspaceCollections(
      scope.activeWorkspaceId,
      scope.workspaces,
      scope.collections,
    );
    const defaultCol = activeCollections.find((collection) => collection.isDefault) ?? activeCollections[0];
    return defaultCol ? { id: defaultCol.id, name: defaultCol.name } : undefined;
  }

  function getDropCollectionId(e: React.DragEvent) {
    const element = e.target instanceof Element
      ? e.target.closest<HTMLElement>("[data-tab-drop-collection-id]")
      : null;
    return element && e.currentTarget.contains(element)
      ? element.dataset.tabDropCollectionId ?? null
      : null;
  }

  const hoveredScope: WorkspaceScope = { activeWorkspaceId, workspaces, collections };
  const resolvedTarget = resolveTargetCollection(targetCollectionId, hoveredScope);
  const targetDropLabel = resolvedTarget
    ? t("workspaceVisibility_dropCollection", [resolvedTarget.name])
    : t("workspaceVisibility_dropDefault");

  function isTabDrag(e: React.DragEvent) {
    return e.dataTransfer.types.includes(DRAG_TYPE);
  }

  function showNotification(n: DropNotification, ms = 3000) {
    setNotification(n);
    setTimeout(() => setNotification(null), ms);
  }

  function handleDragEnter(e: React.DragEvent) {
    if (!isTabDrag(e)) { return; }
    dragCounter.current++;
    setTargetCollectionId(resolveTargetCollection(getDropCollectionId(e), hoveredScope)?.id ?? null);
    setIsDragOver(true);
  }

  function handleDragOver(e: React.DragEvent) {
    if (!isTabDrag(e)) { return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setTargetCollectionId(resolveTargetCollection(getDropCollectionId(e), hoveredScope)?.id ?? null);
  }

  function handleDragLeave() {
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) {
      setIsDragOver(false);
      setTargetCollectionId(null);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const hoveredId = getDropCollectionId(e);
    dragCounter.current = 0;
    setIsDragOver(false);
    setTargetCollectionId(null);

    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (!raw) { return; }

    try {
      const { title, url, favIconUrl } = JSON.parse(raw) as {
        title: string;
        url: string;
        favIconUrl: string;
      };

      // A pull can retire the hovered Collection mid-drag, so re-resolve the
      // target against live state before writing anything.
      const workspaceState = useWorkspaceStore.getState();
      const freshTarget = resolveTargetCollection(hoveredId, workspaceState);
      if (!freshTarget) {
        setSelectedCollection("all");
        showNotification({
          type: "unavailable",
          text: t("workspaceVisibility_targetUnavailable"),
        });
        return;
      }
      const { id: collectionId, name: collectionName } = freshTarget;

      // ── Duplicate detection (current workspace only) ─────────────────────
      if (bookmarks.length > 0) {
        const workspaceColIds = getActiveWorkspaceCollectionIds(
          workspaceState.activeWorkspaceId,
          workspaceState.workspaces,
          workspaceState.collections,
        );
        const workspaceBookmarks = bookmarksAsArray(useBookmarksStore.getState().bookmarks)
          .filter((bookmark) => bookmark.collectionId === "" || workspaceColIds.has(bookmark.collectionId));
        const existing = findDuplicateBookmark(workspaceBookmarks, url);

        if (existing) {
          if (existing.collectionId !== collectionId) {
            updateBookmark(existing.id, { collectionId });
            setHighlightedBookmarkId(existing.id);
            setHighlightedCollectionIds([collectionId], 3000);
            showNotification({ type: "success", text: t("workspaceVisibility_savedTo", [collectionName]) });
            setTimeout(() => setHighlightedBookmarkId(null), 3000);
            return;
          }
          setSelectedCollection(existing.collectionId || "all");
          setHighlightedBookmarkId(existing.id);
          if (existing.collectionId) {
            setHighlightedCollectionIds([existing.collectionId], 3000);
          }
          const colName =
            workspaceState.collections.find((c) => c.id === existing.collectionId)?.name ?? "";
          showNotification(
            { type: "duplicate", text: t("workspaceVisibility_duplicateInCollection", [colName]) },
            3000
          );
          setTimeout(() => setHighlightedBookmarkId(null), 3000);
          return;
        }
      }

      // ── Save new bookmark ────────────────────────────────────────────────
      const bookmark = addBookmark({ title, url, favicon: favIconUrl, collectionId, tags: [], description: "", seq: 0 });
      if (bookmark.id) {
        showNotification({ type: "success", text: t("workspaceVisibility_savedTo", [collectionName]) });
      }
    } catch {
      // ignore malformed drag data
    }
  }

  return {
    isDragOver,
    notification,
    highlightedBookmarkId,
    targetDropLabel,
    targetCollectionId,
    dropZoneProps: {
      onDragEnter: handleDragEnter,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    },
  };
}
