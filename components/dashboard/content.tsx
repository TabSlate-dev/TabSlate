import * as React from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { useTabsDndContext } from "./tabs-dnd-provider";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { useTabDragDrop } from "@/hooks/use-tab-drag-drop";
import { BookmarkCard } from "./bookmark-card";
import { useVirtualizer } from "@tanstack/react-virtual";

import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import {
  X,
  BookmarkPlus,
  Bookmark,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Folder,
  Code,
  Palette,
  Wrench,
  BookOpen,
  Sparkles,
  Star,
  Heart,
  Globe,
  Inbox,
} from "lucide-react";
import type { BookmarkDragData } from "./tabs-dnd-provider";
import type { Bookmark as BookmarkType } from "@/lib/types";

import { HeroSection } from "./hero-section";
import { useTabsStore } from "@/store/tabs-store";
import { EditBookmarkDialog } from "@/components/dashboard/shared/edit-bookmark-dialog";
import { BookmarkTagsDialog } from "@/components/dashboard/shared/bookmark-tags-dialog";
import { CollectionSearch } from "./collection-search";

const ICON_MAP: Record<string, React.ElementType> = {
  folder: Folder,
  bookmark: Bookmark,
  code: Code,
  palette: Palette,
  wrench: Wrench,
  "book-open": BookOpen,
  sparkles: Sparkles,
  star: Star,
  heart: Heart,
  globe: Globe,
  inbox: Inbox,
};

function CollectionIcon({ icon }: { icon: string }) {
  const Icon = ICON_MAP[icon] ?? Folder;
  return <Icon className="size-4" />;
}

interface DroppableCollectionHeaderProps {
  rowData: {
    collectionId: string;
    collectionName: string;
    count: number;
    icon: string;
    isDefault: boolean;
  };
  isExpanded: boolean;
  onToggle: () => void;
}

function DroppableCollectionHeader({ rowData, isExpanded, onToggle }: DroppableCollectionHeaderProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: `content-collection-${rowData.collectionId}`,
  });
  const { activeData } = useTabsDndContext();

  const isAccepting = React.useMemo(() => {
    if (!activeData) return false;
    return ["tab", "tab-group", "bookmark"].includes(activeData.type);
  }, [activeData]);

  return (
    <div
      ref={setNodeRef}
      onClick={onToggle}
      className={cn(
        "group flex items-center justify-between p-3 rounded-xl border transition-all duration-300 cursor-pointer select-none",
        isExpanded
          ? "bg-primary/[0.03] border-primary/20 dark:bg-primary/[0.02] shadow-sm"
          : "bg-card/25 border-muted/20 hover:bg-accent/40 hover:border-primary/20 hover:shadow-md",
        isOver && isAccepting && "border-primary bg-primary/10 ring-1 ring-primary/30 shadow-lg dark:bg-primary/5 scale-[1.01]"
      )}
    >
      <div className="flex items-center gap-3">
        <ChevronDown
          className={cn(
            "size-4 text-muted-foreground group-hover:text-primary transition-all duration-300",
            !isExpanded && "-rotate-90 text-muted-foreground/60"
          )}
        />
        <div className="size-8 rounded-lg bg-primary/5 text-primary flex items-center justify-center border border-primary/10 group-hover:scale-105 transition-transform duration-300">
          <CollectionIcon icon={rowData.icon} />
        </div>
        <span className="font-semibold text-sm tracking-tight text-foreground/90 group-hover:text-primary transition-colors duration-300">
          {rowData.collectionName}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/10">
          {rowData.count}
        </span>
      </div>
    </div>
  );
}

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

type VirtualItem =
  | { type: "hero_and_title" }
  | { type: "collection_header"; collectionId: string; collectionName: string; count: number; icon: string; isDefault: boolean }
  | { type: "bookmarks_row"; collectionId: string; bookmarks: BookmarkType[]; rowIndex: number }
  | { type: "empty_state"; title: string; description: string };

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
  const [expandedCollectionIds, setExpandedCollectionIds] = React.useState<Record<string, boolean>>({});

  React.useEffect(() => {
    setSelectedCollection("all");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId]);

  const { isDragOver, notification, highlightedBookmarkId, targetDropLabel, dropZoneProps } =
    useTabDragDrop();

  const parentRef = React.useRef<HTMLDivElement>(null);
  const gridCols = useContainerColumns(parentRef);

  const workspaceCollectionIds = React.useMemo(
    () => new Set(collections.filter((c) => c.workspaceId === activeWorkspaceId).map((c) => c.id)),
    [collections, activeWorkspaceId]
  );

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

  const virtualRows = React.useMemo<VirtualItem[]>(() => {
    const rows: VirtualItem[] = [];

    // 1. Header (contains hero section + category title + filters info)
    rows.push({ type: "hero_and_title" });

    if (filteredBookmarks.length === 0) {
      rows.push({
        type: "empty_state",
        title: "No bookmarks found",
        description: "Save bookmarks via the popup or drag tabs here to get started.",
      });
      return rows;
    }

    if (selectedCollection !== "all") {
      // Flat view for specific collection
      const colCols = viewMode === "grid" ? gridCols : 1;
      const totalRows = Math.ceil(filteredBookmarks.length / colCols);
      for (let r = 0; r < totalRows; r++) {
        const startIndex = r * colCols;
        const rowItems = filteredBookmarks.slice(startIndex, startIndex + colCols);
        rows.push({
          type: "bookmarks_row",
          collectionId: selectedCollection,
          bookmarks: rowItems,
          rowIndex: r,
        });
      }
    } else {
      // Group by Collection view under "All Bookmarks"
      const groups: Record<string, BookmarkType[]> = {};

      const activeCols = collections
        .filter((c) => c.workspaceId === activeWorkspaceId && !c.deletedAt && !c.archivedAt)
        .sort((a, b) => a.position - b.position);

      activeCols.forEach((c) => {
        groups[c.id] = [];
      });
      groups["uncategorized"] = [];

      filteredBookmarks.forEach((b) => {
        const colId = b.collectionId || "uncategorized";
        if (groups[colId]) {
          groups[colId].push(b);
        } else {
          groups["uncategorized"].push(b);
        }
      });

      // Render active collections
      activeCols.forEach((col) => {
        const colBookmarks = groups[col.id] || [];

        rows.push({
          type: "collection_header",
          collectionId: col.id,
          collectionName: col.name,
          count: colBookmarks.length,
          icon: col.icon,
          isDefault: col.isDefault ?? false,
        });

        const isExpanded = expandedCollectionIds[col.id] ?? col.isDefault;
        if (isExpanded && colBookmarks.length > 0) {
          const colCols = viewMode === "grid" ? gridCols : 1;
          const totalColRows = Math.ceil(colBookmarks.length / colCols);
          for (let r = 0; r < totalColRows; r++) {
            const startIndex = r * colCols;
            const rowItems = colBookmarks.slice(startIndex, startIndex + colCols);
            rows.push({
              type: "bookmarks_row",
              collectionId: col.id,
              bookmarks: rowItems,
              rowIndex: r,
            });
          }
        }
      });

      // Render Uncategorized bookmarks if any
      const uncategorizedBookmarks = groups["uncategorized"] || [];
      if (uncategorizedBookmarks.length > 0) {
        rows.push({
          type: "collection_header",
          collectionId: "uncategorized",
          collectionName: "Uncategorized",
          count: uncategorizedBookmarks.length,
          icon: "bookmark",
          isDefault: false,
        });

        const isExpanded = expandedCollectionIds["uncategorized"] ?? false;
        if (isExpanded) {
          const colCols = viewMode === "grid" ? gridCols : 1;
          const totalColRows = Math.ceil(uncategorizedBookmarks.length / colCols);
          for (let r = 0; r < totalColRows; r++) {
            const startIndex = r * colCols;
            const rowItems = uncategorizedBookmarks.slice(startIndex, startIndex + colCols);
            rows.push({
              type: "bookmarks_row",
              collectionId: "uncategorized",
              bookmarks: rowItems,
              rowIndex: r,
            });
          }
        }
      }
    }

    return rows;
  }, [
    selectedCollection,
    filteredBookmarks,
    collections,
    activeWorkspaceId,
    expandedCollectionIds,
    viewMode,
    gridCols,
  ]);

  const virtualizer = useVirtualizer({
    count: virtualRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      const row = virtualRows[index];
      if (!row) return 50;
      if (row.type === "hero_and_title") {
        return (selectedCollection === "all" && !hasActiveFilters) ? 500 : 130;
      }
      if (row.type === "collection_header") {
        return 58;
      }
      if (row.type === "empty_state") {
        return 200;
      }
      return viewMode === "grid" ? 156 : 80;
    },
    getItemKey: React.useCallback(
      (index: number) => {
        const row = virtualRows[index];
        if (!row) return index;
        if (row.type === "hero_and_title") {
          return `hero-and-title-${selectedCollection === "all" && !hasActiveFilters ? "full" : "compact"}`;
        }
        if (row.type === "empty_state") return "empty-state";
        if (row.type === "collection_header") {
          return `col-header-${row.collectionId}`;
        }
        const ids = row.bookmarks.map((b) => b.id).join("_");
        return `bookmarks-row-${viewMode}-${row.collectionId}-${row.rowIndex}-${ids}`;
      },
      [virtualRows, selectedCollection, hasActiveFilters, viewMode]
    ),
    overscan: 5,
  });

  React.useEffect(() => {
    if (!highlightedBookmarkId) { return; }
    const rowIndex = virtualRows.findIndex(
      (row) =>
        row.type === "bookmarks_row" &&
        row.bookmarks.some((b) => b.id === highlightedBookmarkId)
    );
    if (rowIndex === -1) {
      const targetBookmark = filteredBookmarks.find((b) => b.id === highlightedBookmarkId);
      if (targetBookmark && targetBookmark.collectionId) {
        setExpandedCollectionIds((prev) => ({
          ...prev,
          [targetBookmark.collectionId]: true,
        }));
      }
      return;
    }
    virtualizer.scrollToIndex(rowIndex, { align: "center" });
  }, [highlightedBookmarkId, virtualRows, virtualizer, filteredBookmarks]);

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
          const rowData = virtualRows[virtualRow.index];
          if (!rowData) return null;

          if (rowData.type === "hero_and_title") {
            return (
              <div
                key={virtualRow.key}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
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
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
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
                        {selectedCollection !== "all" && (
                          <CollectionSearch collectionId={selectedCollection} />
                        )}
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
                  </div>
                </div>
              </div>
            );
          }

          if (rowData.type === "empty_state") {
            return (
              <div
                key={virtualRow.key}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                className="px-4 md:px-6 py-8"
              >
                <EmptyState
                  icon={Bookmark}
                  title={rowData.title}
                  description={rowData.description}
                  action={
                    hasActiveFilters ? (
                      <Button variant="outline" size="sm" onClick={() => setFilterType("all")}>
                        Clear filters
                      </Button>
                    ) : undefined
                  }
                />
              </div>
            );
          }

          if (rowData.type === "collection_header") {
            const isExpanded = expandedCollectionIds[rowData.collectionId] ?? rowData.isDefault;
            return (
              <div
                key={virtualRow.key}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                className="px-4 md:px-6 py-1.5"
              >
                <DroppableCollectionHeader
                  rowData={rowData}
                  isExpanded={isExpanded}
                  onToggle={() => {
                    setExpandedCollectionIds((prev) => ({
                      ...prev,
                      [rowData.collectionId]: !isExpanded,
                    }));
                  }}
                />
              </div>
            );
          }

          if (rowData.type === "bookmarks_row") {
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
                {rowData.bookmarks.map((bookmark) => (
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
          }

          return null;
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
