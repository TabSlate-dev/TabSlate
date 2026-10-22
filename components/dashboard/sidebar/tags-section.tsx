import * as React from "react";
import { Check, Palette, Pencil, Plus, Search, Tag as TagIcon, Trash2, X } from "lucide-react";
import { SidebarGroup, SidebarGroupContent } from "@/components/ui/sidebar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { TAG_COLORS, useWorkspaceStore } from "@/store/workspace-store";
import { getActiveWorkspaceCollectionIds } from "@/lib/workspace-visibility";
import { useTranslation } from "@/hooks/use-translation";
import type { Bookmark, Tag } from "@/lib/types";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TagDeleteDialog } from "./tag-delete-dialog";
import { SectionHeader } from "./section-header";
import { TagDialog } from "./tag-dialog";

/** Active bookmarks in every workspace that carry the tag; tags are global. */
function countBookmarksWithTag(bookmarks: Map<string, Bookmark>, tagId: string): number {
  let count = 0;
  for (const bookmark of bookmarks.values()) {
    if (bookmark.tags.includes(tagId)) {
      count += 1;
    }
  }
  return count;
}

function swatchClass(color: string): string {
  return color.split(" ")[0].replace("/10", "");
}

/** Bookmarks in the active workspace (its collections plus uncategorized) per tag. */
function countTagsInWorkspace(
  bookmarks: Map<string, Bookmark>,
  workspaceCollectionIds: ReadonlySet<string>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const bookmark of bookmarks.values()) {
    if (bookmark.collectionId !== "" && !workspaceCollectionIds.has(bookmark.collectionId)) {
      continue;
    }
    for (const tagId of bookmark.tags) {
      counts.set(tagId, (counts.get(tagId) ?? 0) + 1);
    }
  }
  return counts;
}

function HighlightedName({ name, query }: { name: string; query: string }) {
  const index = query ? name.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (index === -1) {
    return <>{name}</>;
  }
  return (
    <>
      {name.slice(0, index)}
      <mark className="rounded-sm bg-yellow-300/60 text-inherit dark:bg-yellow-500/40">
        {name.slice(index, index + query.length)}
      </mark>
      {name.slice(index + query.length)}
    </>
  );
}

export function SidebarTagsSection() {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [newTagOpen, setNewTagOpen] = React.useState(false);

  const bookmarks = useBookmarksStore((s) => s.bookmarks);
  const selectedTags = useBookmarksStore((s) => s.selectedTags);
  const toggleTag = useBookmarksStore((s) => s.toggleTag);
  const clearTags = useBookmarksStore((s) => s.clearTags);
  const tags = useWorkspaceStore((s) => s.tags);
  const collections = useWorkspaceStore((s) => s.collections);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const createTag = useWorkspaceStore((s) => s.createTag);
  const deleteTag = useWorkspaceStore((s) => s.deleteTag);

  const [editingTag, setEditingTag] = React.useState<Tag | null>(null);
  const [tagActionError, setTagActionError] = React.useState<string | null>(null);
  const [deletingTag, setDeletingTag] = React.useState<Tag | null>(null);
  const updateTag = useWorkspaceStore((s) => s.updateTag);
  const deletingCount = React.useMemo(
    () => (deletingTag ? countBookmarksWithTag(bookmarks, deletingTag.id) : 0),
    [bookmarks, deletingTag],
  );
  const editingTakenNames = React.useMemo(
    () => (editingTag ? tags.filter((tag) => tag.id !== editingTag.id).map((tag) => tag.name) : []),
    [tags, editingTag],
  );

  const workspaceCollectionIds = React.useMemo(
    () => getActiveWorkspaceCollectionIds(activeWorkspaceId, workspaces, collections),
    [activeWorkspaceId, workspaces, collections],
  );
  const tagCounts = React.useMemo(
    () => countTagsInWorkspace(bookmarks, workspaceCollectionIds),
    [bookmarks, workspaceCollectionIds],
  );
  const trimmedQuery = query.trim();
  const visibleTags = React.useMemo(() => {
    const needle = trimmedQuery.toLowerCase();
    return needle ? tags.filter((tag) => tag.name.toLowerCase().includes(needle)) : tags;
  }, [tags, trimmedQuery]);
  const tagNames = React.useMemo(() => tags.map((tag) => tag.name), [tags]);

  // Another device can delete a selected tag; with no chip left to clear it, it would keep filtering bookmarks.
  React.useEffect(() => {
    const tagIds = new Set(tags.map((tag) => tag.id));
    // Reads the live selection, so running again cannot toggle a dropped tag back on.
    for (const tagId of useBookmarksStore.getState().selectedTags) {
      if (!tagIds.has(tagId)) {
        toggleTag(tagId);
      }
    }
  }, [tags, toggleTag]);

  const handleColorChange = React.useCallback(async (id: string, color: string) => {
    const result = await updateTag(id, { color });
    if (result.ok) { setTagActionError(null); return; }
    setTagActionError(t(result.error === "storage" ? "tagAction_errorStorage" : result.error === "stale" ? "tagAction_errorStale" : result.error === "quota" ? "tagAction_errorQuota" : "tagAction_errorInvalid"));
  }, [updateTag, t]);

  const handleToggleOpen = React.useCallback(() => setOpen((value) => !value), []);
  const handleOpenSearch = React.useCallback(() => {
    setOpen(true);
    setSearchOpen(true);
  }, []);
  const handleCloseSearch = React.useCallback(() => {
    setSearchOpen(false);
    setQuery("");
  }, []);

  return (
    <SidebarGroup className="p-0">
      {searchOpen ? (
        <div className="flex items-center gap-1 px-1 py-1">
          <Input
            autoFocus
            value={query}
            aria-label={t("sidebar_searchTags")}
            placeholder={t("sidebar_searchTagsPlaceholder")}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                handleCloseSearch();
              }
            }}
            className="h-7 text-xs"
          />
          <button
            type="button"
            aria-label={t("sidebar_closeTagSearch")}
            onClick={handleCloseSearch}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : (
        <SectionHeader
          label={t("sidebar_tags")}
          open={open}
          onToggle={handleToggleOpen}
          actions={
            <div className="ml-auto flex items-center gap-1">
              {selectedTags.length > 0 && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    clearTags();
                  }}
                  className="text-[10px] text-muted-foreground hover:text-foreground"
                >
                  {t("sidebar_clearTags")}
                </button>
              )}
              <button
                type="button"
                aria-label={t("sidebar_searchTags")}
                onClick={handleOpenSearch}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <Search className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label={t("sidebar_newTag")}
                onClick={() => setNewTagOpen(true)}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <Plus className="size-3.5" />
              </button>
            </div>
          }
        />
      )}

      {tagActionError && (
        <Alert variant="destructive" className="mt-2 px-2 py-2">
          <AlertDescription>{tagActionError}</AlertDescription>
        </Alert>
      )}
      {open && (
        <SidebarGroupContent>
          <div className="flex flex-wrap gap-1.5 mt-2 px-1">
            {tags.length === 0 && (
              <p className="text-xs text-muted-foreground w-full py-1">{t("sidebar_noTagsYet")}</p>
            )}
            {visibleTags.map((tag) => {
              const count = tagCounts.get(tag.id) ?? 0;
              const selected = selectedTags.includes(tag.id);
              return (
                <Tooltip key={tag.id} delayDuration={1000}>
                  <ContextMenu>
                    <TooltipTrigger asChild>
                      <ContextMenuTrigger asChild>
                        <button
                          type="button"
                          data-tag-id={tag.id}
                          aria-pressed={selected}
                          onClick={() => toggleTag(tag.id)}
                          className={cn(
                            "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium transition-colors",
                            selected ? "bg-primary text-primary-foreground" : tag.color,
                          )}
                        >
                          <TagIcon className="size-3" />
                          <HighlightedName name={tag.name} query={trimmedQuery} />
                          <span data-tag-count className={cn("tabular-nums", count === 0 ? "opacity-50" : "opacity-80")}>
                            {count}
                          </span>
                        </button>
                      </ContextMenuTrigger>
                    </TooltipTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onSelect={() => setEditingTag(tag)}>
                        <Pencil className="size-4" />
                        {t("tagMenu_rename")}
                      </ContextMenuItem>
                      <ContextMenuSub>
                        <ContextMenuSubTrigger>
                          <Palette className="size-4" />
                          {t("tagMenu_color")}
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent>
                          {TAG_COLORS.map((color, index) => (
                            <ContextMenuItem key={color} onSelect={() => { void handleColorChange(tag.id, color); }}>
                              <span className={cn("size-3 rounded-full", swatchClass(color))} />
                              {t("tagDialog_colorOption", [String(index + 1)])}
                              {tag.color === color && <Check className="ml-auto size-4" />}
                            </ContextMenuItem>
                          ))}
                        </ContextMenuSubContent>
                      </ContextMenuSub>
                      <ContextMenuSeparator />
                      <ContextMenuItem variant="destructive" onSelect={() => setDeletingTag(tag)}>
                        <Trash2 className="size-4" />
                        {t("tagMenu_delete")}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                  <TooltipContent side="top">{t("sidebar_tagRightClickHint")}</TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </SidebarGroupContent>
      )}

      <TagDialog
        open={newTagOpen}
        onOpenChange={setNewTagOpen}
        takenNames={tagNames}
        onSubmit={createTag}
      />
      {editingTag && (
        <TagDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setEditingTag(null);
            }
          }}
          initial={editingTag}
          takenNames={editingTakenNames}
          onSubmit={(name, color) => updateTag(editingTag.id, { name, color })}
        />
      )}
      {deletingTag && (
        <TagDeleteDialog
          tag={deletingTag}
          bookmarkCount={deletingCount}
          onClose={() => setDeletingTag(null)}
          onConfirm={async () => {
            if (!useWorkspaceStore.getState().tags.some(tag => tag.id === deletingTag.id)) { return { ok: true }; }
            const result = await deleteTag(deletingTag.id);
            if (!result.ok) { return result; }
            if (useBookmarksStore.getState().selectedTags.includes(deletingTag.id)) { toggleTag(deletingTag.id); }
            return result;
          }}
        />
      )}
    </SidebarGroup>
  );
}
