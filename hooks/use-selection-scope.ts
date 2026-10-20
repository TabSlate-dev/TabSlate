import * as React from "react";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useSelectionStore } from "@/store/selection-store";
import { useWorkspaceStore } from "@/store/workspace-store";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.isContentEditable || target.closest("input, textarea, select") !== null;
}

/**
 * Ties the selection to the view that shows it. The selection keeps only
 * bookmarks still in `viewOrder`; it clears when the active workspace,
 * selected collection, tags, filter or search change, when the view unmounts
 * (a route change), and on Esc, unless another component handled the key
 * (Radix calls preventDefault when it closes a menu or dialog) or it came
 * from a field.
 */
export function useSelectionScope(viewOrder: readonly string[]): void {
  const retain = useSelectionStore((s) => s.retain);
  const clear = useSelectionStore((s) => s.clear);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const selectedCollection = useBookmarksStore((s) => s.selectedCollection);
  const selectedTags = useBookmarksStore((s) => s.selectedTags);
  const filterType = useBookmarksStore((s) => s.filterType);
  const searchQuery = useBookmarksStore((s) => s.searchQuery);

  React.useEffect(() => {
    clear();
  }, [activeWorkspaceId, selectedCollection, selectedTags, filterType, searchQuery, clear]);

  React.useEffect(() => () => clear(), [clear]);

  React.useEffect(() => {
    retain(viewOrder);
  }, [viewOrder, retain]);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isEditableTarget(event.target)) {
        return;
      }
      clear();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [clear]);
}
