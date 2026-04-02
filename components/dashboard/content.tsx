import * as React from "react";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { useTabDragDrop } from "@/hooks/use-tab-drag-drop";
import { BookmarkCard } from "./bookmark-card";
import { StatsCards } from "./stats-cards";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { X, BookmarkPlus, Bookmark, AlertCircle } from "lucide-react";

export function BookmarksContent() {
  const {
    selectedCollection,
    getFilteredBookmarks,
    viewMode,
    selectedTags,
    toggleTag,
    filterType,
    setFilterType,
    sortBy,
  } = useBookmarksStore();

  const { collections, tags, activeWorkspaceId } = useWorkspaceStore();
  const { isDragOver, notification, highlightedBookmarkId, targetDropLabel, dropZoneProps } =
    useTabDragDrop();

  // Scroll highlighted bookmark into view after collection switch + re-render
  React.useEffect(() => {
    if (!highlightedBookmarkId) { return; }
    const timer = setTimeout(() => {
      document
        .querySelector(`[data-bookmark-id="${highlightedBookmarkId}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 100);
    return () => clearTimeout(timer);
  }, [highlightedBookmarkId]);

  const workspaceCollectionIds = new Set(
    collections.filter((c) => c.workspaceId === activeWorkspaceId).map((c) => c.id)
  );
  const filteredBookmarks = getFilteredBookmarks(workspaceCollectionIds);

  const currentCollection =
    selectedCollection === "all"
      ? { name: "All Bookmarks" }
      : collections.find((c) => c.id === selectedCollection);

  const activeTagsData = tags.filter((t) => selectedTags.includes(t.id));
  const hasActiveFilters =
    selectedTags.length > 0 || filterType !== "all" || sortBy !== "date-newest";

  return (
    <div className="flex-1 w-full overflow-auto relative" {...dropZoneProps}>
      {/* Drop overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-background/80 backdrop-blur-sm border-2 border-dashed border-primary rounded-lg pointer-events-none">
          <BookmarkPlus className="size-10 text-primary" />
          <p className="text-base font-semibold text-primary">{targetDropLabel}</p>
        </div>
      )}

      {/* Notification toast */}
      {notification && (
        <div
          className={cn(
            "absolute top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium shadow-lg animate-in fade-in slide-in-from-top-2 pointer-events-none whitespace-nowrap",
            notification.type === "success"
              ? "bg-primary text-primary-foreground"
              : "bg-amber-500 text-white"
          )}
        >
          {notification.type === "success" ? (
            <BookmarkPlus className="size-4 shrink-0" />
          ) : (
            <AlertCircle className="size-4 shrink-0" />
          )}
          {notification.text}
        </div>
      )}

      <div className="p-4 md:p-6 space-y-6">
        <StatsCards />

        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold">
                {currentCollection?.name || "All Bookmarks"}
              </h2>
              <p className="text-sm text-muted-foreground">
                {filteredBookmarks.length} bookmark
                {filteredBookmarks.length !== 1 ? "s" : ""}
                {hasActiveFilters && " (filtered)"}
              </p>
            </div>

            {(activeTagsData.length > 0 || filterType !== "all") && (
              <div className="flex flex-wrap items-center gap-2">
                {filterType !== "all" && (
                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-primary/10 text-primary">
                    {filterType === "favorites" && "Favorites only"}
                    {filterType === "with-tags" && "With tags"}
                    {filterType === "without-tags" && "Without tags"}
                    <button
                      onClick={() => setFilterType("all")}
                      className="hover:bg-primary/20 rounded-full p-0.5"
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                )}
                {activeTagsData.map((tag) => (
                  <span
                    key={tag.id}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-primary text-primary-foreground"
                  >
                    {tag.name}
                    <button
                      onClick={() => toggleTag(tag.id)}
                      className="hover:bg-primary-foreground/20 rounded-full p-0.5"
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {viewMode === "grid" ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {filteredBookmarks.map((bookmark) => (
                <BookmarkCard
                  key={bookmark.id}
                  bookmark={bookmark}
                  isHighlighted={bookmark.id === highlightedBookmarkId}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {filteredBookmarks.map((bookmark) => (
                <BookmarkCard
                  key={bookmark.id}
                  bookmark={bookmark}
                  variant="list"
                  isHighlighted={bookmark.id === highlightedBookmarkId}
                />
              ))}
            </div>
          )}

          {filteredBookmarks.length === 0 && (
            <EmptyState
              icon={Bookmark}
              title="No bookmarks found"
              description="Save bookmarks via the popup or drag tabs here to get started."
              action={
                hasActiveFilters ? (
                  <Button variant="outline" size="sm" onClick={() => setFilterType("all")}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}
