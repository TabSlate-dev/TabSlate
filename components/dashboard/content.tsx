import * as React from "react";
import { useDraggable } from "@dnd-kit/core";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { useTabDragDrop } from "@/hooks/use-tab-drag-drop";
import { BookmarkCard } from "./bookmark-card";

import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { X, BookmarkPlus, Bookmark, AlertCircle } from "lucide-react";
import type { BookmarkDragData } from "./tabs-dnd-provider";
import type { Bookmark as BookmarkType } from "@/lib/types";

import { HeroSection } from "./hero-section";
import { useTabsStore } from "@/store/tabs-store";
// import { SearchPanel } from "@/components/search/search-panel";

interface DraggableBookmarkCardProps {
  bookmark: BookmarkType;
  variant?: "grid" | "list";
  isHighlighted?: boolean;
}

function DraggableBookmarkCard({ bookmark, variant = "grid", isHighlighted }: DraggableBookmarkCardProps) {
  const dragData: BookmarkDragData = {
    type: "bookmark",
    bookmarkId: bookmark.id,
    title: bookmark.title,
    url: bookmark.url,
    favicon: bookmark.favicon,
    variant,
  };
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: `bookmark-${bookmark.id}`,
    data: dragData,
  });

  return (
    <div ref={setNodeRef} {...listeners} {...attributes} className="relative">
      <div className={cn(isDragging && "opacity-0 pointer-events-none")}>
        <BookmarkCard
          bookmark={bookmark}
          variant={variant}
          isHighlighted={isHighlighted}
          dragHandleProps={{ "data-drag-handle": true }}
        />
      </div>
      {isDragging && (
        <div className="absolute inset-0 rounded-xl border-2 border-dashed border-muted-foreground/25 bg-muted/10" />
      )}
    </div>
  );
}

export function BookmarksContent() {
  const openTabs = useTabsStore(s => s.openTabs);
  const loadTabs = useTabsStore(s => s.loadTabs);

  React.useEffect(() => {
    if (openTabs.length === 0) { loadTabs(true); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedCollection = useBookmarksStore(s => s.selectedCollection);
  const setSelectedCollection = useBookmarksStore(s => s.setSelectedCollection);
  const viewMode = useBookmarksStore(s => s.viewMode);
  const selectedTags = useBookmarksStore(s => s.selectedTags);
  const toggleTag = useBookmarksStore(s => s.toggleTag);
  const filterType = useBookmarksStore(s => s.filterType);
  const setFilterType = useBookmarksStore(s => s.setFilterType);
  const sortBy = useBookmarksStore(s => s.sortBy);
  const bookmarks = useBookmarksStore(s => s.bookmarks);
  const searchQuery = useBookmarksStore(s => s.searchQuery);
  const getFilteredBookmarks = useBookmarksStore(s => s.getFilteredBookmarks);

  const collections = useWorkspaceStore(s => s.collections);
  const tags = useWorkspaceStore(s => s.tags);
  const activeWorkspaceId = useWorkspaceStore(s => s.activeWorkspaceId);

  React.useEffect(() => {
    setSelectedCollection("all");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId]);

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

  const workspaceCollectionIds = React.useMemo(
    () => new Set(collections.filter((c) => c.workspaceId === activeWorkspaceId).map((c) => c.id)),
    [collections, activeWorkspaceId]
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const filteredBookmarks = React.useMemo(
    () => getFilteredBookmarks(workspaceCollectionIds),
    [bookmarks, selectedCollection, selectedTags, filterType, searchQuery, sortBy, workspaceCollectionIds]
  );

  const currentCollection =
    selectedCollection === "all"
      ? { name: "All Bookmarks" }
      : collections.find((c) => c.id === selectedCollection);

  const activeTagsData = React.useMemo(
    () => tags.filter((t) => selectedTags.includes(t.id)),
    [tags, selectedTags]
  );
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

      {/* Notification Toast */}
      {notification && (
        <Alert
          variant={notification.type === "duplicate" ? "default" : "info"}
          className={cn(
            "fixed top-4 left-1/2 -translate-x-1/2 z-100 w-auto shadow-lg animate-in fade-in slide-in-from-top-2 pointer-events-none whitespace-nowrap",
            notification.type === "duplicate" && "border-amber-500/50 text-amber-600 bg-amber-50/90 dark:bg-amber-950/20"
          )}
        >
          {notification.type === "success" ? (
            <BookmarkPlus className="size-4" />
          ) : (
            <AlertCircle className="size-4" />
          )}
          <AlertDescription>{notification.text}</AlertDescription>
        </Alert>
      )}

      <div className="p-4 md:p-6 space-y-6">
        {/* Inline search */}
        {/*
        <div className="w-full">
          <SearchPanel
            openTabs={openTabs}
            smartOpen
          />
        </div>
        */}
        {selectedCollection === "all" && !hasActiveFilters && <HeroSection />}


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
                <DraggableBookmarkCard
                  key={bookmark.id}
                  bookmark={bookmark}
                  isHighlighted={bookmark.id === highlightedBookmarkId}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {filteredBookmarks.map((bookmark) => (
                <DraggableBookmarkCard
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
