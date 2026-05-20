import * as React from "react";
import { useDraggable } from "@dnd-kit/core";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { useTabDragDrop } from "@/hooks/use-tab-drag-drop";
import { BookmarkCard } from "./bookmark-card";
import { useVirtualizer } from "@tanstack/react-virtual";

import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { X, BookmarkPlus, Bookmark, AlertCircle } from "lucide-react";
import type { BookmarkDragData } from "./tabs-dnd-provider";
import type { Bookmark as BookmarkType } from "@/lib/types";

import { HeroSection } from "./hero-section";
import { useTabsStore } from "@/store/tabs-store";
import { EditBookmarkDialog } from "@/components/dashboard/shared/edit-bookmark-dialog";
import { BookmarkTagsDialog } from "@/components/dashboard/shared/bookmark-tags-dialog";

function colsFromWidth(width: number) {
  if (width >= 1280) return 4;
  if (width >= 1024) return 3;
  if (width >= 640) return 2;
  return 1;
}

function useContainerColumns(ref: React.RefObject<HTMLElement | null>) {
  const [cols, setCols] = React.useState(1);
  React.useEffect(() => {
    if (!ref.current) return;
    setCols(colsFromWidth(ref.current.getBoundingClientRect().width));
    const observer = new ResizeObserver((entries) => {
      setCols(colsFromWidth(entries[0].contentRect.width));
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref]);
  return cols;
}

interface DraggableBookmarkCardProps {
  bookmark: BookmarkType;
  variant?: "grid" | "list";
  isHighlighted?: boolean;
  onEdit?: (bookmark: BookmarkType) => void;
  onAddTags?: (bookmark: BookmarkType) => void;
}

const DraggableBookmarkCard = React.memo(function DraggableBookmarkCard({ bookmark, variant = "grid", isHighlighted, onEdit, onAddTags }: DraggableBookmarkCardProps) {
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
    <div ref={setNodeRef} {...listeners} {...attributes} className="relative h-full">
      <div className={cn(isDragging && "opacity-0 pointer-events-none", "h-full")}>
        <BookmarkCard
          bookmark={bookmark}
          variant={variant}
          isHighlighted={isHighlighted}
          dragHandleProps={{ "data-drag-handle": true }}
          onEdit={onEdit}
          onAddTags={onAddTags}
        />
      </div>
      {isDragging && (
        <div className="absolute inset-0 rounded-xl border-2 border-dashed border-muted-foreground/25 bg-muted/10" />
      )}
    </div>
  );
});

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

  const [editingBookmark, setEditingBookmark] = React.useState<BookmarkType | null>(null);
  const [taggingBookmark, setTaggingBookmark] = React.useState<BookmarkType | null>(null);

  const prevWorkspaceIdRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (prevWorkspaceIdRef.current !== null && prevWorkspaceIdRef.current !== activeWorkspaceId) {
      setSelectedCollection("all");
    }
    prevWorkspaceIdRef.current = activeWorkspaceId;
  }, [activeWorkspaceId, setSelectedCollection]);

  const { isDragOver, notification, highlightedBookmarkId, targetDropLabel, dropZoneProps } =
    useTabDragDrop();

  const parentRef = React.useRef<HTMLDivElement>(null);
  const gridCols = useContainerColumns(parentRef);

  const workspaceCollectionIds = React.useMemo(
    () => new Set(collections.filter((c) => c.workspaceId === activeWorkspaceId).map((c) => c.id)),
    [collections, activeWorkspaceId]
  );

  // getFilteredBookmarks reads internal store state via get(); the deps below are the
  // reactive inputs it actually observes — the function reference itself is stable.
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

  const actualCols = viewMode === "grid" ? gridCols : 1;
  const rowCount = Math.ceil(filteredBookmarks.length / actualCols);

  const virtualizer = useVirtualizer({
    count: rowCount + 1,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => {
      if (i !== 0) return viewMode === "grid" ? 156 : 80;
      return (selectedCollection === "all" && !hasActiveFilters) ? 500 : 130;
    },
    overscan: 5,
  });

  React.useEffect(() => {
    if (!highlightedBookmarkId) { return; }
    const bookmarkIndex = filteredBookmarks.findIndex(b => b.id === highlightedBookmarkId);
    if (bookmarkIndex === -1) { return; }
    const rowIndex = Math.floor(bookmarkIndex / actualCols);
    virtualizer.scrollToIndex(rowIndex + 1, { align: "center" });
  }, [highlightedBookmarkId, filteredBookmarks, actualCols, virtualizer]);

  return (
    <div ref={parentRef} className="flex-1 w-full overflow-auto relative" {...dropZoneProps}>
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

      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          if (virtualRow.index === 0) {
            return (
              <div
                key="header"
                ref={virtualizer.measureElement}
                data-index={0}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                  zIndex: 10,
                }}
              >
                <div className="p-4 md:p-6 space-y-6 pb-4">
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

          const rowIndex = virtualRow.index - 1;
          const startIndex = rowIndex * actualCols;
          const rowItems = filteredBookmarks.slice(startIndex, startIndex + actualCols);

          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
                ...(viewMode === "grid" ? { gridTemplateColumns: `repeat(${actualCols}, minmax(0, 1fr))` } : {}),
              }}
              className={viewMode === "grid" ? "grid gap-4 px-4 md:px-6 pb-4" : "flex flex-col gap-2 px-4 md:px-6 pb-4"}
            >
              {rowItems.map((bookmark) => (
                <DraggableBookmarkCard
                  key={bookmark.id}
                  bookmark={bookmark}
                  variant={viewMode}
                  isHighlighted={bookmark.id === highlightedBookmarkId}
                  onEdit={setEditingBookmark}
                  onAddTags={setTaggingBookmark}
                />
              ))}
            </div>
          );
        })}
      </div>

      {editingBookmark && (
        <EditBookmarkDialog
          bookmark={editingBookmark}
          open={!!editingBookmark}
          onOpenChange={(open) => !open && setEditingBookmark(null)}
        />
      )}
      {taggingBookmark && (
        <BookmarkTagsDialog
          bookmark={taggingBookmark}
          open={!!taggingBookmark}
          onOpenChange={(open) => !open && setTaggingBookmark(null)}
        />
      )}
    </div>
  );
}
