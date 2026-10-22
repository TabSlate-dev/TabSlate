import { BulkActionBar } from "@/components/dashboard/bulk-actions";
import { SelectionOrdersProvider } from "@/components/dashboard/shared/selection-orders";
import { useSelectionScope } from "@/hooks/use-selection-scope";

import * as React from "react";
import { sortBookmarks } from "@/lib/bookmark-utils";
import { bookmarksAsArray, useBookmarksStore } from "@/store/bookmarks-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { BookmarkCard } from "./bookmark-card";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { ActiveFilterChips } from "@/components/dashboard/shared/active-filter-chips";
import { Heart } from "lucide-react";
import { useTranslation } from "@/hooks/use-translation";
import { getActiveWorkspaceCollectionIds } from "@/lib/workspace-visibility";

export function FavoritesContent() {
  const { t } = useTranslation();
  const bookmarks = useBookmarksStore(s => bookmarksAsArray(s.bookmarks));
  const viewMode = useBookmarksStore(s => s.viewMode);
  const sortBy = useBookmarksStore(s => s.sortBy);
  const selectedTags = useBookmarksStore(s => s.selectedTags);
  const clearTags = useBookmarksStore(s => s.clearTags);

  const collections = useWorkspaceStore(s => s.collections);
  const workspaces = useWorkspaceStore(s => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore(s => s.activeWorkspaceId);

  const workspaceCollectionIds = React.useMemo(
    () => getActiveWorkspaceCollectionIds(activeWorkspaceId, workspaces, collections),
    [activeWorkspaceId, workspaces, collections]
  );

  const allFavorites = React.useMemo(
    () => bookmarks.filter(
      b => b.isFavorite && (b.collectionId === "" || workspaceCollectionIds.has(b.collectionId))
    ),
    [bookmarks, workspaceCollectionIds]
  );

  const favoriteBookmarks = React.useMemo(
    () => sortBookmarks(
      selectedTags.length === 0
        ? allFavorites
        : allFavorites.filter(b => selectedTags.some(tag => b.tags.includes(tag))),
      sortBy,
    ),
    [allFavorites, selectedTags, sortBy]
  );

  const viewOrder = React.useMemo(() => favoriteBookmarks.map((bookmark) => bookmark.id), [favoriteBookmarks]);
  useSelectionScope(viewOrder);

  return (
    <SelectionOrdersProvider viewOrder={viewOrder} onScreenOrder={viewOrder}>
      <div className="flex-1 w-full overflow-auto">
        <div className="p-4 md:p-6 space-y-6">
          <div className="flex items-center gap-3 p-4 rounded-xl border bg-card">
            <div className="size-10 rounded-lg bg-red-500/10 text-red-500 flex items-center justify-center">
              <Heart className="size-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">{t("favoritesContent_title")}</h2>
              <p className="text-sm text-muted-foreground">
                {t(favoriteBookmarks.length === 1 ? "favoritesContent_count_one" : "favoritesContent_count_other", [favoriteBookmarks.length.toString()])} {t("favoritesContent_markedAsFavorite")}
                {selectedTags.length > 0 && t("favoritesContent_filtered")}
              </p>
            </div>
          </div>

          <ActiveFilterChips />

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {favoriteBookmarks.map((bookmark) => (
              <BookmarkCard key={bookmark.id} bookmark={bookmark} variant={viewMode} />
            ))}
          </div>

          {favoriteBookmarks.length === 0 && allFavorites.length > 0 && (
            <EmptyState
              icon={Heart}
              title={t("favoritesContent_noMatchTitle")}
              description={t("favoritesContent_noMatchDesc")}
              action={
                <Button variant="outline" size="sm" onClick={() => clearTags()}>
                  {t("favoritesContent_clearTagFilter")}
                </Button>
              }
            />
          )}

          {allFavorites.length === 0 && (
            <EmptyState
              icon={Heart}
              title={t("favoritesContent_emptyTitle")}
              description={t("favoritesContent_emptyDesc")}
            />
          )}
        </div>
        <BulkActionBar />
      </div>
    </SelectionOrdersProvider>
  );
}
