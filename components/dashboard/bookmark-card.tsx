import * as React from "react";
import {
  Heart,
  MoreHorizontal,
  ExternalLink,
  Copy,
  Check,
  GripVertical,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { smartOpenUrl, openInNewTab } from "@/lib/chrome/tabs";
import type { Bookmark, Tag } from "@/lib/types";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FaviconImage } from "@/components/ui/favicon-image";
import { TagList } from "@/components/ui/tag-list";
import { useTranslation } from "@/hooks/use-translation";

import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { BookmarkMenuItems } from "@/components/dashboard/shared/bookmark-menu-items";
import {
  contextMenuPrimitives,
  dropdownMenuPrimitives,
  type MenuPrimitives,
} from "@/components/dashboard/shared/menu-primitives";

import { useSelectionStore } from "@/store/selection-store";
import { isToggleSelectionClick } from "@/lib/platform";
import { openBookmarkDialog } from "@/lib/bookmark-dialog-events";
import { useSelectionOrders } from "@/components/dashboard/shared/selection-orders";

const EMPTY_TAGS: Tag[] = [];

interface BookmarkCardProps {
  bookmark: Bookmark;
  variant?: "grid" | "list";
  isHighlighted?: boolean;
  dragHandleProps?: React.HTMLAttributes<HTMLDivElement> & {
    "data-drag-handle"?: boolean;
  };
}

interface SelectionCheckboxProps {
  title: string;
  checked: boolean;
  /** Shown without hovering, e.g. while any card is selected. */
  visible: boolean;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

/** Covers the favicon square, so showing it never shifts the card's layout. */
export function SelectionCheckbox({ title, checked, visible, onClick }: SelectionCheckboxProps) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={t("bookmarkCard_select", [title])}
      onClick={onClick}
      className={cn(
        "absolute inset-0 flex items-center justify-center bg-muted transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        visible ? "opacity-100" : "opacity-0 group-hover:opacity-100",
      )}
    >
      <span
        className={cn(
          "flex size-4 items-center justify-center rounded-sm border",
          checked ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/60 bg-background",
        )}
      >
        {checked && <Check className="size-3" />}
      </span>
    </button>
  );
}

export const BookmarkCard = React.memo(function BookmarkCard({
  bookmark,
  variant = "grid",
  isHighlighted = false,
  dragHandleProps,
}: BookmarkCardProps) {
  const { t } = useTranslation();
  const toggleFavorite = useBookmarksStore((s) => s.toggleFavorite);
  const archiveBookmark = useBookmarksStore((s) => s.archiveBookmark);
  const trashBookmark = useBookmarksStore((s) => s.trashBookmark);
  const selectedTags = useBookmarksStore((s) => s.selectedTags);
  const toggleTag = useBookmarksStore((s) => s.toggleTag);

  const selectionOrders = useSelectionOrders();
  const selectable = selectionOrders !== null;
  const isSelected = useSelectionStore((s) => selectable && s.selectedIds.has(bookmark.id));
  const selectionActive = useSelectionStore((s) => selectable && s.selectedIds.size > 0);
  const toggleSelection = useSelectionStore((s) => s.toggle);
  const selectRange = useSelectionStore((s) => s.selectRange);

  const tags = useWorkspaceStore((s) => s.tags);
  const bookmarkTags = React.useMemo(
    () =>
      bookmark.tags.length === 0
        ? EMPTY_TAGS
        : tags.filter((tag) => bookmark.tags.includes(tag.id)),
    [tags, bookmark.tags]
  );
  const [copied, setCopied] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);

  const handleCopyUrl = React.useCallback(() => {
    navigator.clipboard.writeText(bookmark.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [bookmark.url]);
  const handleSmartOpen = React.useCallback(() => smartOpenUrl(bookmark.url), [bookmark.url]);
  const handleNewTabOpen = React.useCallback(() => openInNewTab(bookmark.url), [bookmark.url]);

  const handleEdit = React.useCallback(() => openBookmarkDialog({ bookmarkId: bookmark.id }), [bookmark.id]);
  const handleAddTags = React.useCallback(
    () => openBookmarkDialog({ bookmarkId: bookmark.id, focus: "tags" }),
    [bookmark.id],
  );
  const handleArchive = React.useCallback(() => archiveBookmark(bookmark.id), [archiveBookmark, bookmark.id]);
  const handleDelete = React.useCallback(() => trashBookmark(bookmark.id), [trashBookmark, bookmark.id]);

  const handleCardClick = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (selectionOrders) {
      if (event.shiftKey) {
        selectRange(selectionOrders.current.onScreenOrder, bookmark.id);
        return;
      }
      if (isToggleSelectionClick(event) || selectionActive) {
        toggleSelection(bookmark.id);
        return;
      }
    }
    void handleSmartOpen();
  }, [selectionOrders, selectionActive, selectRange, toggleSelection, bookmark.id, handleSmartOpen]);

  const handleCheckboxClick = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (selectionOrders && event.shiftKey) {
      selectRange(selectionOrders.current.onScreenOrder, bookmark.id);
      return;
    }
    toggleSelection(bookmark.id);
  }, [selectionOrders, selectRange, toggleSelection, bookmark.id]);

  // Shift+click selects a range of cards, not the page text between them.
  const handleCardMouseDown = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (selectable && event.shiftKey) {
      event.preventDefault();
    }
  }, [selectable]);

  const renderMenuItems = (menu: MenuPrimitives) => (
    <BookmarkMenuItems
      menu={menu}
      onOpenSmart={handleSmartOpen}
      onOpenNewTab={handleNewTabOpen}
      onEdit={handleEdit}
      onAddTags={handleAddTags}
      onArchive={handleArchive}
      onDelete={handleDelete}
    />
  );

  // ── List variant ────────────────────────────────────────────────────────
  if (variant === "list") {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            data-bookmark-id={bookmark.id}
            data-selected={isSelected || undefined}
            className={cn(
              "group flex items-center gap-4 p-4 rounded-lg border bg-card/40 hover:bg-accent/50 backdrop-blur-lg hover:shadow-md hover:border-primary/20 transition-all duration-200 z-0 hover:z-10 cursor-pointer",
              menuOpen &&
                "bg-accent/50 backdrop-blur-lg shadow-md border-primary/20 z-10",
              isHighlighted &&
                "ring-2 ring-amber-500 shadow-[0_0_15px_rgba(245,158,11,0.3)] bg-amber-50/50 dark:ring-amber-400 dark:shadow-[0_0_20px_rgba(251,191,36,0.2)] dark:bg-amber-950/20 animate-pulse-subtle",
              isSelected && "border-primary/40 bg-primary/5 ring-2 ring-primary/60",
            )}
            onClick={handleCardClick}
            onMouseDown={handleCardMouseDown}
          >
            {dragHandleProps && (
              <div
                {...dragHandleProps}
                onClick={(e) => e.stopPropagation()}
                className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground -ml-2"
              >
                <GripVertical className="size-4" />
              </div>
            )}

            <div className="relative size-10 rounded-lg bg-muted flex items-center justify-center overflow-hidden shrink-0">
              <FaviconImage
                src={bookmark.favicon}
                alt={bookmark.title}
                className="size-6"
                hasDarkIcon={bookmark.hasDarkIcon}
              />
              {selectable && (
                <SelectionCheckbox title={bookmark.title} checked={isSelected} visible={selectionActive} onClick={handleCheckboxClick} />
              )}
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="font-medium truncate">{bookmark.title}</h3>
                <TagList tags={bookmarkTags} max={2} className="hidden sm:flex" onTagClick={toggleTag} selectedTagIds={selectedTags} />
              </div>
              <p className="text-sm text-muted-foreground truncate">
                {bookmark.url}
              </p>
            </div>

            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => toggleFavorite(bookmark.id)}
              >
                <Heart
                  className={cn(
                    "size-4",
                    bookmark.isFavorite && "fill-red-500 text-red-500",
                  )}
                />
              </Button>
              <Button variant="ghost" size="icon-xs" onClick={handleSmartOpen}>
                <ExternalLink className="size-4" />
              </Button>
              <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-xs" aria-label={t("bookmarkCard_moreActions")}>
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">{renderMenuItems(dropdownMenuPrimitives)}</DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>{renderMenuItems(contextMenuPrimitives)}</ContextMenuContent>
      </ContextMenu>
    );
  }

  // ── Grid variant (compact, redesigned) ──────────────────────────────────
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-bookmark-id={bookmark.id}
          data-selected={isSelected || undefined}
          className={cn(
            "group relative flex flex-col rounded-xl border bg-card/40 hover:bg-accent/50 backdrop-blur-lg hover:shadow-lg hover:border-primary/20 transition-all duration-200 cursor-pointer z-0 hover:z-10",
            menuOpen &&
              "bg-accent/50 backdrop-blur-lg shadow-lg border-primary/20 z-10",
            isHighlighted &&
              "ring-2 ring-amber-500 shadow-[0_0_15px_rgba(245,158,11,0.3)] bg-amber-50/50 dark:ring-amber-400 dark:shadow-[0_0_20px_rgba(251,191,36,0.2)] dark:bg-amber-950/20 animate-pulse-subtle",
            isSelected && "border-primary/40 bg-primary/5 ring-2 ring-primary/60",
          )}
          onClick={handleCardClick}
          onMouseDown={handleCardMouseDown}
        >
          {/* Header: favicon + title + slide-in actions */}
          <div className="flex items-center gap-2 px-3 pt-3 pb-2">
            {/* Drag handle */}
            {dragHandleProps && (
              <div
                {...dragHandleProps}
                onClick={(e) => e.stopPropagation()}
                className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground -ml-1"
              >
                <GripVertical className="size-3.5" />
              </div>
            )}
            {/* Favicon */}
            <div className="relative size-7 rounded-md bg-muted shrink-0 flex items-center justify-center overflow-hidden">
              <FaviconImage
                src={bookmark.favicon}
                alt={bookmark.title}
                className="size-4"
                hasDarkIcon={bookmark.hasDarkIcon}
              />
              {selectable && (
                <SelectionCheckbox title={bookmark.title} checked={isSelected} visible={selectionActive} onClick={handleCheckboxClick} />
              )}
            </div>

            {/* Title */}
            <h3 className="flex-1 text-sm font-medium truncate min-w-0">
              {bookmark.title}
            </h3>

            {/* Actions — stop propagation so card click isn't triggered */}
            <div
              className="flex items-center shrink-0 group/actions relative"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Copied popup — outside overflow-hidden so it's not clipped */}
              {copied && (
                <div className="absolute bottom-full right-0 mb-1 px-1.5 py-0.5 rounded text-xs font-medium bg-green-500 text-white whitespace-nowrap pointer-events-none animate-in fade-in slide-in-from-bottom-2 duration-150">
                  {t("bookmarkCard_copied")}
                </div>
              )}

              {/* Slide in when hovering actions area, or while menu is open */}
              <div
                className={cn(
                  "flex items-center overflow-hidden transition-all duration-200 ease-out",
                  menuOpen ? "max-w-14" : "max-w-0 group-hover/actions:max-w-14",
                )}
              >
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0"
                  onClick={() => toggleFavorite(bookmark.id)}
                >
                  <Heart
                    className={cn(
                      "size-3.5",
                      bookmark.isFavorite && "fill-red-500 text-red-500",
                    )}
                  />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0"
                  onClick={handleCopyUrl}
                >
                  {copied ? (
                    <Check className="size-3.5 text-green-500" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                </Button>
              </div>

              {/* Always visible: three-dot menu */}
              <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-xs" aria-label={t("bookmarkCard_moreActions")}>
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">{renderMenuItems(dropdownMenuPrimitives)}</DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* URL — one line, truncated */}
          <p className="px-3 pb-2 text-xs text-muted-foreground truncate">
            {bookmark.url}
          </p>

          {/* Tags */}
          {bookmarkTags.length > 0 && (
            <div className="px-3 pb-3">
              <TagList tags={bookmarkTags} max={3} onTagClick={toggleTag} selectedTagIds={selectedTags} />
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>{renderMenuItems(contextMenuPrimitives)}</ContextMenuContent>
    </ContextMenu>
  );
});
