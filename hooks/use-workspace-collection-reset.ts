import { useEffect } from "react";

/**
 * Falls back to "All bookmarks" when the selected collection is not part of
 * the active workspace. A collection selected together with a workspace
 * switch (revealBookmark) already belongs to it and is kept.
 */
export function useWorkspaceCollectionReset(
  selectedCollection: string,
  workspaceCollectionIds: ReadonlySet<string>,
  setSelectedCollection: (collectionId: string) => void,
): void {
  useEffect(() => {
    if (selectedCollection !== "all" && !workspaceCollectionIds.has(selectedCollection)) {
      setSelectedCollection("all");
    }
  }, [selectedCollection, workspaceCollectionIds, setSelectedCollection]);
}
