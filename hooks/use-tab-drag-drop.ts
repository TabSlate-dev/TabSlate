import * as React from "react";
import { bookmarksAsArray, useBookmarksStore } from "@/store/bookmarks-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { findDuplicateBookmark } from "@/lib/bookmark-utils";
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
  /** Spread these props onto the drop-zone container element */
  dropZoneProps: {
    onDragEnter: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (e: React.DragEvent) => void;
  };
}

const DRAG_TYPE = "application/tabslate-tab";


export function useTabDragDrop(): UseTabDragDropResult {
  const { t } = useTranslation();
  const addBookmark = useBookmarksStore((state) => state.addBookmark);
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
  const [notification, setNotification] = React.useState<DropNotification | null>(null);
  const [highlightedBookmarkId, setHighlightedBookmarkId] = React.useState<string | null>(null);

  function resolveTargetCollection(): { id: string; name: string } | undefined {
    if (selectedCollection !== "all") {
      const collection = resolveActiveWorkspaceCollectionTarget(
        selectedCollection,
        activeWorkspaceId,
        workspaces,
        collections,
      );
      return collection ? { id: collection.id, name: collection.name } : undefined;
    }
    const activeCollections = getActiveWorkspaceCollections(
      activeWorkspaceId,
      workspaces,
      collections,
    );
    const defaultCol = activeCollections.find((collection) => collection.isDefault) ?? activeCollections[0];
    return defaultCol ? { id: defaultCol.id, name: defaultCol.name } : undefined;
  }

  const resolvedTarget = resolveTargetCollection();
  const targetDropLabel =
    selectedCollection === "all"
      ? t("workspaceVisibility_dropDefault")
      : t("workspaceVisibility_dropCollection", [resolvedTarget?.name ?? ""]);

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
    setIsDragOver(true);
  }

  function handleDragOver(e: React.DragEvent) {
    if (!isTabDrag(e)) { return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave() {
    dragCounter.current--;
    if (dragCounter.current === 0) { setIsDragOver(false); }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current = 0;
    setIsDragOver(false);

    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (!raw) { return; }

    try {
      const { title, url, favIconUrl } = JSON.parse(raw) as {
        title: string;
        url: string;
        favIconUrl: string;
      };

      // ── Duplicate detection (current workspace only) ─────────────────────
      if (bookmarks.length > 0) {
        const workspaceState = useWorkspaceStore.getState();
        const workspaceColIds = getActiveWorkspaceCollectionIds(
          workspaceState.activeWorkspaceId,
          workspaceState.workspaces,
          workspaceState.collections,
        );
        const workspaceBookmarks = bookmarksAsArray(useBookmarksStore.getState().bookmarks)
          .filter((bookmark) => bookmark.collectionId === "" || workspaceColIds.has(bookmark.collectionId));
        const existing = findDuplicateBookmark(workspaceBookmarks, url);

        if (existing) {
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
      const workspaceState = useWorkspaceStore.getState();
      const activeCollections = getActiveWorkspaceCollections(
        workspaceState.activeWorkspaceId,
        workspaceState.workspaces,
        workspaceState.collections,
      );
      const freshTarget = selectedCollection === "all"
        ? activeCollections.find((collection) => collection.isDefault) ?? activeCollections[0]
        : resolveActiveWorkspaceCollectionTarget(
            selectedCollection,
            workspaceState.activeWorkspaceId,
            workspaceState.workspaces,
            workspaceState.collections,
          );
      if (!freshTarget) {
        setSelectedCollection("all");
        showNotification({
          type: "unavailable",
          text: t("workspaceVisibility_targetUnavailable"),
        });
        return;
      }
      const { id: collectionId, name: collectionName } = freshTarget;
      addBookmark({ title, url, favicon: favIconUrl, collectionId, tags: [], description: "", seq: 0 });
      showNotification({ type: "success", text: t("workspaceVisibility_savedTo", [collectionName]) });
    } catch {
      // ignore malformed drag data
    }
  }

  return {
    isDragOver,
    notification,
    highlightedBookmarkId,
    targetDropLabel,
    dropZoneProps: {
      onDragEnter: handleDragEnter,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    },
  };
}
