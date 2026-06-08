import * as React from "react";
import {
  Heart,
  MoreHorizontal,
  ExternalLink,
  Copy,
  Check,
  Pencil,
  Trash2,
  Tag as TagIcon,
  Archive,
  GripVertical,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { smartOpenUrl } from "@/lib/chrome/tabs";
import type { Bookmark, Tag } from "@/lib/types";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FaviconImage } from "@/components/ui/favicon-image";
import { TagList } from "@/components/ui/tag-list";
import { useTranslation } from "@/hooks/use-translation";

const EMPTY_TAGS: Tag[] = [];

interface BookmarkCardProps {
  bookmark: Bookmark;
  variant?: "grid" | "list";
  isHighlighted?: boolean;
  dragHandleProps?: React.HTMLAttributes<HTMLDivElement> & {
    "data-drag-handle"?: boolean;
  };
  onEdit?: (bookmark: Bookmark) => void;
  onAddTags?: (bookmark: Bookmark) => void;
}

export const BookmarkCard = React.memo(function BookmarkCard({
  bookmark,
  variant = "grid",
  isHighlighted = false,
  dragHandleProps,
  onEdit,
  onAddTags,
}: BookmarkCardProps) {
  const { t } = useTranslation();
  const toggleFavorite = useBookmarksStore((s) => s.toggleFavorite);
  const archiveBookmark = useBookmarksStore((s) => s.archiveBookmark);
  const trashBookmark = useBookmarksStore((s) => s.trashBookmark);
  
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
  const handleNewTabOpen = React.useCallback(() => window.open(bookmark.url, "_blank"), [bookmark.url]);

  // Shared dropdown content for both variants
  const actionsMenu = React.useMemo(() => (
    <DropdownMenuContent align="end">
      <DropdownMenuItem onClick={handleSmartOpen}>
        <ExternalLink className="size-4 mr-2" />
        {t("bookmarkCard_openSmart")}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={handleNewTabOpen}>
        <ExternalLink className="size-4 mr-2" />
        {t("bookmarkCard_openNewTab")}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => { setMenuOpen(false); onEdit?.(bookmark); }}>
        <Pencil className="size-4 mr-2" />
        {t("bookmarkCard_edit")}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => { setMenuOpen(false); onAddTags?.(bookmark); }}>
        <TagIcon className="size-4 mr-2" />
        {t("bookmarkCard_addTags")}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => archiveBookmark(bookmark.id)}>
        <Archive className="size-4 mr-2" />
        {t("bookmarkCard_archive")}
      </DropdownMenuItem>
      <DropdownMenuItem
        className="text-destructive"
        onClick={() => trashBookmark(bookmark.id)}
      >
        <Trash2 className="size-4 mr-2" />
        {t("bookmarkCard_delete")}
      </DropdownMenuItem>
    </DropdownMenuContent>
  ), [handleSmartOpen, handleNewTabOpen, onEdit, onAddTags, archiveBookmark, trashBookmark, bookmark, t]);

  // ── List variant ────────────────────────────────────────────────────────
  if (variant === "list") {
    return (
      <>
        <div
          data-bookmark-id={bookmark.id}
          className={cn(
            "group flex items-center gap-4 p-4 rounded-lg border bg-card/40 hover:bg-accent/50 backdrop-blur-lg hover:shadow-md hover:border-primary/20 transition-all duration-200 z-0 hover:z-10 cursor-pointer",
            menuOpen &&
              "bg-accent/50 backdrop-blur-lg shadow-md border-primary/20 z-10",
            isHighlighted &&
              "ring-2 ring-amber-500 shadow-[0_0_15px_rgba(245,158,11,0.3)] bg-amber-50/50 dark:ring-amber-400 dark:shadow-[0_0_20px_rgba(251,191,36,0.2)] dark:bg-amber-950/20 animate-pulse-subtle",
          )}
          onClick={handleSmartOpen}
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

          <div className="size-10 rounded-lg bg-muted flex items-center justify-center overflow-hidden shrink-0">
            <FaviconImage
              src={bookmark.favicon}
              alt={bookmark.title}
              className="size-6"
              hasDarkIcon={bookmark.hasDarkIcon}
            />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-medium truncate">{bookmark.title}</h3>
              <TagList tags={bookmarkTags} max={2} className="hidden sm:flex" />
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
                <Button variant="ghost" size="icon-xs">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              {actionsMenu}
            </DropdownMenu>
          </div>
        </div>
      </>
    );
  }

  // ── Grid variant (compact, redesigned) ──────────────────────────────────
  return (
    <>
      <div
        data-bookmark-id={bookmark.id}
        className={cn(
          "group relative flex flex-col rounded-xl border bg-card/40 hover:bg-accent/50 backdrop-blur-lg hover:shadow-lg hover:border-primary/20 transition-all duration-200 cursor-pointer z-0 hover:z-10",
          menuOpen &&
            "bg-accent/50 backdrop-blur-lg shadow-lg border-primary/20 z-10",
          isHighlighted &&
            "ring-2 ring-amber-500 shadow-[0_0_15px_rgba(245,158,11,0.3)] bg-amber-50/50 dark:ring-amber-400 dark:shadow-[0_0_20px_rgba(251,191,36,0.2)] dark:bg-amber-950/20 animate-pulse-subtle",
        )}
        onClick={handleSmartOpen}
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
          <div className="size-7 rounded-md bg-muted shrink-0 flex items-center justify-center overflow-hidden">
            <FaviconImage
              src={bookmark.favicon}
              alt={bookmark.title}
              className="size-4"
              hasDarkIcon={bookmark.hasDarkIcon}
            />
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
                <Button variant="ghost" size="icon-xs">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              {actionsMenu}
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
            <TagList tags={bookmarkTags} max={3} />
          </div>
        )}
      </div>
    </>
  );
});
