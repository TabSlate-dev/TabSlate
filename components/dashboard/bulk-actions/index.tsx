import * as React from "react";
import { Archive, FolderInput, Heart, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
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

  const selected = React.useMemo(() => activeBookmarks(selectedIds, bookmarks), [selectedIds, bookmarks]);
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
            <Button type="button" variant="ghost" size="sm" onClick={handleFavorite}>
              <Heart className={cn("size-4", allFavorites && "fill-red-500 text-red-500")} />
              {t(allFavorites ? "bulkActions_unfavorite" : "bulkActions_favorite")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={handleArchive}>
              <Archive className="size-4" />
              {t("bulkActions_archive")}
            </Button>
            <Button type="button" variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={handleDelete}>
              <Trash2 className="size-4" />
              {t("bulkActions_delete")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={handleSelectAll}>
              {t("bulkActions_selectAll")}
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t("bulkActions_clear")} onClick={clearSelection}>
              <X className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
