import { useBookmarksStore } from "@/store/bookmarks-store";
import { BookmarkCard } from "./bookmark-card";
import { EmptyState } from "@/components/ui/empty-state";
import { Heart } from "lucide-react";

export function FavoritesContent() {
  const { getFavoriteBookmarks, viewMode } = useBookmarksStore();
  const favoriteBookmarks = getFavoriteBookmarks();

  return (
    <div className="flex-1 w-full overflow-auto">
      <div className="p-4 md:p-6 space-y-6">
        <div className="flex items-center gap-3 p-4 rounded-xl border bg-card">
          <div className="size-10 rounded-lg bg-red-500/10 text-red-500 flex items-center justify-center">
            <Heart className="size-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Favorite Bookmarks</h2>
            <p className="text-sm text-muted-foreground">
              {favoriteBookmarks.length} bookmark
              {favoriteBookmarks.length !== 1 ? "s" : ""} marked as favorite
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
          <div className="flex flex-col gap-2">
            {favoriteBookmarks.map((bookmark) => (
              <BookmarkCard key={bookmark.id} bookmark={bookmark} variant="list" />
            ))}
          </div>
        )}

        {favoriteBookmarks.length === 0 && (
          <EmptyState
            icon={Heart}
            title="No favorites yet"
            description="Mark bookmarks as favorites by clicking the heart icon to see them here."
          />
        )}
      </div>
    </div>
  );
}
