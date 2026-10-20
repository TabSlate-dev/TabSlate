import * as React from "react";
import { Archive, ChevronDown, ExternalLink, FolderInput, Heart, MoreHorizontal, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { supportsTabGroups } from "@/lib/browser/capabilities";
import { formatLinkList, formatMarkdownLinkList } from "@/lib/bookmark-clipboard";
import { openUrlsInBackground } from "@/lib/chrome/tabs";
import { useTabsStore } from "@/store/tabs-store";
import { OpenTabsConfirmDialog } from "./open-tabs-confirm-dialog";
import { CollectionPicker } from "@/components/dashboard/shared/collection-picker";
import { useSelectionOrders } from "@/components/dashboard/shared/selection-orders";
import { useTranslation } from "@/hooks/use-translation";
import type { Bookmark } from "@/lib/types";
import { cn } from "@/lib/utils";
import { resolveActiveWorkspaceCollectionTarget } from "@/lib/workspace-visibility";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useSelectionStore } from "@/store/selection-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { BulkNotice, useBulkNotice } from "./bulk-notice";
import { BulkTagsMenu } from "./tags-menu";

/** Opening more tabs than this asks first. */
const OPEN_CONFIRM_THRESHOLD = 10;
type OpenMode = "tabs" | "group";

/** The active bookmarks behind `ids`, in the order of `ids`. */
function activeBookmarks(ids: Iterable<string>, bookmarks: ReadonlyMap<string, Bookmark>): Bookmark[] {
  const result: Bookmark[] = [];
  for (const id of ids) {
    const bookmark = bookmarks.get(id);
    if (bookmark) {
      result.push(bookmark);
    }
  }
  return result;
}

/**
 * The toolbar for the selection, stuck to the bottom of the view's scroll
 * container. It stays mounted while nothing is selected, so a notice outlives
 * the selection it reports on.
 */
export function BulkActionBar() {
  const { t } = useTranslation();
  const orders = useSelectionOrders();
  const selectedIds = useSelectionStore((s) => s.selectedIds);
  const setMany = useSelectionStore((s) => s.setMany);
  const clearSelection = useSelectionStore((s) => s.clear);
  const bookmarks = useBookmarksStore((s) => s.bookmarks);
  const updateBookmarks = useBookmarksStore((s) => s.updateBookmarks);
  const archiveBookmarks = useBookmarksStore((s) => s.archiveBookmarks);
  const trashBookmarks = useBookmarksStore((s) => s.trashBookmarks);
  const [notice, showNotice] = useBulkNotice();
  const openUrlsAsGroup = useTabsStore((s) => s.openUrlsAsGroup);
  const [pendingOpen, setPendingOpen] = React.useState<OpenMode | null>(null);

  // Observe empty transitions directly: clear and reselect can share a React batch.
  React.useEffect(() => useSelectionStore.subscribe((state) => {
    if (state.selectedIds.size === 0) {
      setPendingOpen(null);
    }
  }), []);

  const selected = React.useMemo(() => activeBookmarks(selectedIds, bookmarks), [selectedIds, bookmarks]);
  React.useEffect(() => {
    if (selected.length === 0) {
      setPendingOpen(null);
    }
  }, [selected.length]);
  const allFavorites = selected.length > 0 && selected.every((bookmark) => bookmark.isFavorite);
  const countText = selected.length > 0 ? t("bulkActions_selectedCount", [String(selected.length)]) : "";

  const handleMove = (collectionId: string) => {
    const state = useWorkspaceStore.getState();
    const target = resolveActiveWorkspaceCollectionTarget(collectionId, state.activeWorkspaceId, state.workspaces, state.collections);
    if (!target) {
      showNotice({ tone: "error", message: t("workspaceVisibility_targetUnavailable") });
      return;
    }
    const moving = selected.filter((bookmark) => bookmark.collectionId !== target.id);
    updateBookmarks(moving.map((bookmark) => ({ id: bookmark.id, patch: { collectionId: target.id } })));
    clearSelection();
    showNotice({
      tone: "success",
      message: moving.length === 1
        ? t("bulkActions_movedOne", [target.name])
        : t("bulkActions_movedOther", [String(moving.length), target.name]),
    });
  };

  const handleFavorite = () => {
    updateBookmarks(selected.map((bookmark) => ({ id: bookmark.id, patch: { isFavorite: !allFavorites } })));
  };

  const handleArchive = () => {
    archiveBookmarks(selected.map((bookmark) => bookmark.id));
    clearSelection();
    showNotice({
      tone: "success",
      message: selected.length === 1 ? t("bulkActions_archivedOne") : t("bulkActions_archivedOther", [String(selected.length)]),
      link: { label: t("bulkActions_viewArchive"), to: "/archive" },
    });
  };

  const handleDelete = () => {
    trashBookmarks(selected.map((bookmark) => bookmark.id));
    clearSelection();
    showNotice({
      tone: "success",
      message: selected.length === 1 ? t("bulkActions_trashedOne") : t("bulkActions_trashedOther", [String(selected.length)]),
      link: { label: t("bulkActions_viewTrash"), to: "/trash" },
    });
  };

  const handleSelectAll = () => {
    setMany(orders?.current.onScreenOrder ?? [], true);
  };

  /** The selected bookmarks in the view's display order. */
  const selectedInViewOrder = () =>
    activeBookmarks((orders?.current.viewOrder ?? []).filter((id) => selectedIds.has(id)), bookmarks);

  /** The shared collection's name when the bookmarks share one, otherwise the active workspace's. */
  const groupTitleFor = (ordered: readonly Bookmark[]): string => {
    const state = useWorkspaceStore.getState();
    const collectionIds = new Set(ordered.map((bookmark) => bookmark.collectionId));
    const [onlyCollectionId] = collectionIds;
    const shared = collectionIds.size === 1
      ? state.collections.find((collection) => collection.id === onlyCollectionId)
      : undefined;
    return shared?.name ?? state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId)?.name ?? "";
  };

  const openSelection = async (mode: OpenMode) => {
    const ordered = selectedInViewOrder();
    const urls = ordered.map((bookmark) => bookmark.url);
    try {
      if (mode === "group") {
        await openUrlsAsGroup(urls, groupTitleFor(ordered), "grey");
      } else {
        await openUrlsInBackground(urls);
      }
    } catch {
      showNotice({ tone: "error", message: t("bulkActions_openFailed") });
    }
  };

  const handleOpen = (mode: OpenMode) => {
    if (selected.length > OPEN_CONFIRM_THRESHOLD) {
      setPendingOpen(mode);
      return;
    }
    void openSelection(mode);
  };

  const handleConfirmOpen = () => {
    const mode = pendingOpen;
    setPendingOpen(null);
    if (mode) {
      void openSelection(mode);
    }
  };

  const handleCopy = async (format: "plain" | "markdown") => {
    const ordered = selectedInViewOrder();
    const text = format === "markdown" ? formatMarkdownLinkList(ordered) : formatLinkList(ordered);
    try {
      await navigator.clipboard.writeText(text);
      showNotice({
        tone: "success",
        message: ordered.length === 1 ? t("bulkActions_copiedOne") : t("bulkActions_copiedOther", [String(ordered.length)]),
      });
    } catch {
      showNotice({ tone: "error", message: t("bulkActions_copyFailed") });
    }
  };

  return (
    <>
      {notice && <BulkNotice notice={notice} />}
      <div className="sr-only" aria-live="polite">{countText}</div>
      {selected.length > 0 && (
        <div className="pointer-events-none sticky bottom-0 z-20 flex justify-center px-4 pb-4">
          <div
            role="toolbar"
            aria-label={t("bulkActions_toolbarLabel")}
            className="pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-lg"
          >
            <span className="whitespace-nowrap px-2 text-sm font-medium">{countText}</span>
            <CollectionPicker selectedId={null} onSelect={handleMove} align="center">
              <Button type="button" variant="ghost" size="sm">
                <FolderInput className="size-4" />
                {t("bulkActions_moveTo")}
              </Button>
            </CollectionPicker>
            <BulkTagsMenu bookmarks={selected} />
            <Button type="button" variant="ghost" size="sm" onClick={handleFavorite}>
              <Heart className={cn("size-4", allFavorites && "fill-red-500 text-red-500")} />
              {t(allFavorites ? "bulkActions_unfavorite" : "bulkActions_favorite")}
            </Button>
            <Button type="button" variant="ghost" size="sm" className="hidden sm:inline-flex" onClick={handleArchive}>
              <Archive className="size-4" />
              {t("bulkActions_archive")}
            </Button>
            <Button type="button" variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={handleDelete}>
              <Trash2 className="size-4" />
              {t("bulkActions_delete")}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="hidden sm:inline-flex">
                  <ExternalLink className="size-4" />
                  {t("bulkActions_open")}
                  <ChevronDown className="size-3.5 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center">
                <DropdownMenuItem onSelect={() => handleOpen("tabs")}>{t("bulkActions_openAll")}</DropdownMenuItem>
                {supportsTabGroups() && (
                  <DropdownMenuItem onSelect={() => handleOpen("group")}>{t("bulkActions_openAsGroup")}</DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={t("bulkActions_more")}>
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void handleCopy("plain")}>{t("bulkActions_copyLinks")}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void handleCopy("markdown")}>{t("bulkActions_copyMarkdown")}</DropdownMenuItem>
                {/* Below the sm breakpoint, Open and Archive live here. */}
                <DropdownMenuSeparator className="sm:hidden" />
                <DropdownMenuItem className="sm:hidden" onSelect={() => handleOpen("tabs")}>{t("bulkActions_openAll")}</DropdownMenuItem>
                {supportsTabGroups() && (
                  <DropdownMenuItem className="sm:hidden" onSelect={() => handleOpen("group")}>{t("bulkActions_openAsGroup")}</DropdownMenuItem>
                )}
                <DropdownMenuItem className="sm:hidden" onSelect={handleArchive}>{t("bulkActions_archive")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button type="button" variant="ghost" size="sm" onClick={handleSelectAll}>
              {t("bulkActions_selectAll")}
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t("bulkActions_clear")} onClick={clearSelection}>
              <X className="size-4" />
            </Button>
          </div>
          <OpenTabsConfirmDialog
            count={selected.length}
            open={pendingOpen !== null}
            onOpenChange={(open) => {
              if (!open) {
                setPendingOpen(null);
              }
            }}
            onConfirm={handleConfirmOpen}
          />
        </div>
      )}
    </>
  );
}
