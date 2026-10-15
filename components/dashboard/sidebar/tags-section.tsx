import * as React from "react";
import { Plus, Search, Tag as TagIcon, X } from "lucide-react";
import { SidebarGroup, SidebarGroupContent } from "@/components/ui/sidebar";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { getActiveWorkspaceCollectionIds } from "@/lib/workspace-visibility";
import { useTranslation } from "@/hooks/use-translation";
import type { Bookmark } from "@/lib/types";
import { SectionHeader } from "./section-header";
import { TagDialog } from "./tag-dialog";

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
                <button
                  key={tag.id}
                  type="button"
                  data-tag-id={tag.id}
                  aria-pressed={selected}
                  onClick={() => toggleTag(tag.id)}
                  className={cn(
                    "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium transition-colors group/tag",
                    selected ? "bg-primary text-primary-foreground" : tag.color,
                  )}
                >
                  <TagIcon className="size-3" />
                  <HighlightedName name={tag.name} query={trimmedQuery} />
                  <span data-tag-count className={cn("tabular-nums", count === 0 ? "opacity-50" : "opacity-80")}>
                    {count}
                  </span>
                  <span
                    role="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      deleteTag(tag.id);
                    }}
                    className="hidden group-hover/tag:inline ml-0.5 hover:opacity-70"
                  >
                    ×
                  </span>
                </button>
              );
            })}
          </div>
        </SidebarGroupContent>
      )}

      <TagDialog
        open={newTagOpen}
        onOpenChange={setNewTagOpen}
        takenNames={tagNames}
        onSubmit={(name, color) => {
          createTag(name, color);
        }}
      />
    </SidebarGroup>
  );
}
