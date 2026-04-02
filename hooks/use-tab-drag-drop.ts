import * as React from "react";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { normalizeUrl, findDuplicateBookmark } from "@/lib/bookmark-utils";

export interface DropNotification {
  text: string;
  type: "success" | "duplicate";
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
  const { addBookmark, bookmarks, selectedCollection, setSelectedCollection } =
    useBookmarksStore();
  const { collections, activeWorkspaceId } = useWorkspaceStore();

  const dragCounter = React.useRef(0);
  const [isDragOver, setIsDragOver] = React.useState(false);
  const [notification, setNotification] = React.useState<DropNotification | null>(null);
  const [highlightedBookmarkId, setHighlightedBookmarkId] = React.useState<string | null>(null);

  function resolveTargetCollection(): { id: string; name: string } {
    if (selectedCollection !== "all") {
      const col = collections.find((c) => c.id === selectedCollection);
      return { id: selectedCollection, name: col?.name ?? "collection" };
    }
    const defaultCol = collections.find(
      (c) => c.workspaceId === activeWorkspaceId && c.isDefault
    );
    return { id: defaultCol?.id ?? "", name: "Default collection" };
  }

  const targetDropLabel =
    selectedCollection === "all"
      ? "Drop to save to Default collection"
      : `Drop to save to "${resolveTargetCollection().name}"`;

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

      // ── Duplicate detection ──────────────────────────────────────────────
      if (Array.isArray(bookmarks)) {
        const existing = findDuplicateBookmark(bookmarks, url);

        if (existing) {
          console.log("TabSlate: Duplicate tab detected", { url, existingId: existing.id });
          const workspaceColIds = new Set(
            collections
              .filter((c) => c.workspaceId === activeWorkspaceId)
              .map((c) => c.id)
          );
          const isVisible =
            existing.collectionId === "" || workspaceColIds.has(existing.collectionId);

          if (isVisible) {
            // Navigate to the duplicate and highlight it
            setSelectedCollection(existing.collectionId || "all");
            setHighlightedBookmarkId(existing.id);
            const colName =
              collections.find((c) => c.id === existing.collectionId)?.name ?? "Default";
            showNotification(
              { type: "duplicate", text: `Already saved in "${colName}"` },
              3500
            );
            setTimeout(() => setHighlightedBookmarkId(null), 3500);
          } else {
            showNotification(
              { type: "duplicate", text: "Already saved in another workspace" },
              3000
            );
          }
          return;
        }
      } else {
        console.error("TabSlate: Bookmarks is not an array, skipping duplicate detection.");
      }

      // ── Save new bookmark ────────────────────────────────────────────────
      const { id: collectionId, name: collectionName } = resolveTargetCollection();
      addBookmark({ title, url, favicon: favIconUrl, collectionId, tags: [], description: "" });
      showNotification({ type: "success", text: `Saved to ${collectionName}` });
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
