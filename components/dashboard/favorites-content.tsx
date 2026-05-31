import * as React from "react";
import { bookmarksAsArray, useBookmarksStore } from "@/store/bookmarks-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { BookmarkCard } from "./bookmark-card";
import { EmptyState } from "@/components/ui/empty-state";
import { Heart } from "lucide-react";
import { useTranslation } from "@/hooks/use-translation";

export function FavoritesContent() {
  const { t } = useTranslation();
  const bookmarks = useBookmarksStore(s => bookmarksAsArray(s.bookmarks));
  const viewMode = useBookmarksStore(s => s.viewMode);

  const collections = useWorkspaceStore(s => s.collections);
  const activeWorkspaceId = useWorkspaceStore(s => s.activeWorkspaceId);

  const workspaceCollectionIds = React.useMemo(
    () => new Set(
      collections
        .filter(c => c.workspaceId === activeWorkspaceId && !c.deletedAt && !c.archivedAt)
        .map(c => c.id)
    ),
    [collections, activeWorkspaceId]
  );

  const favoriteBookmarks = React.useMemo(
    () => bookmarks.filter(
      b => b.isFavorite && (b.collectionId === "" || workspaceCollectionIds.has(b.collectionId))
    ),
    [bookmarks, workspaceCollectionIds]
  );

  return (
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
            </p>
          </div>
        </div>

        {viewMode === "grid" ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {favoriteBookmarks.map((bookmark) => (
              <BookmarkCard key={bookmark.id} bookmark={bookmark} />
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {favoriteBookmarks.map((bookmark) => (
              <BookmarkCard key={bookmark.id} bookmark={bookmark} variant="list" />
            ))}
          </div>
        )}

        {favoriteBookmarks.length === 0 && (
          <EmptyState
            icon={Heart}
            title={t("favoritesContent_emptyTitle")}
            description={t("favoritesContent_emptyDesc")}
          />
        )}
      </div>
    </div>
  );
}
