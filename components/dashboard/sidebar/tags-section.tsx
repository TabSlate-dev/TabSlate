import * as React from "react";
import { MoreHorizontal, Plus, Search, Sparkles, X } from "lucide-react";
import { SidebarGroup, SidebarGroupContent } from "@/components/ui/sidebar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { getActiveWorkspaceCollectionIds } from "@/lib/workspace-visibility";
import { useTranslation } from "@/hooks/use-translation";
import { useTagTree } from "@/hooks/use-tag-tree";
import { useTagTreeExpansion } from "@/hooks/use-tag-tree-expansion";
import { tagAncestors } from "@/lib/tag-tree";
import { tagTargetError } from "@/lib/tag-mutations";
import type { Bookmark, Tag } from "@/lib/types";
import { TagTreeRow } from "./tag-tree-row";
import { TagDeleteDialog } from "./tag-delete-dialog";
import { TagMergeDialog } from "./tag-merge-dialog";
import { UnusedTagsDialog } from "./unused-tags-dialog";
import { SectionHeader } from "./section-header";
import { TagDialog } from "./tag-dialog";
import { TagTreePicker } from "@/components/dashboard/shared/tag-tree-picker";

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

export function SidebarTagsSection() {
  const { t } = useTranslation();
  const tree = useTagTree();
  const [open, setOpen] = React.useState(false);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [newTagOpen, setNewTagOpen] = React.useState(false);
  const [childParentTag, setChildParentTag] = React.useState<Tag | null>(null);

  const bookmarks = useBookmarksStore((s) => s.bookmarks);
  const selectedTags = useBookmarksStore((s) => s.selectedTags);
  const toggleTag = useBookmarksStore((s) => s.toggleTag);
  const clearTags = useBookmarksStore((s) => s.clearTags);
  const tags = useWorkspaceStore((s) => s.tags);
  const collections = useWorkspaceStore((s) => s.collections);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const createTagPath = useWorkspaceStore((s) => s.createTagPath);
  const updateTag = useWorkspaceStore((s) => s.updateTag);
  const moveTag = useWorkspaceStore((s) => s.moveTag);
  const deleteTag = useWorkspaceStore((s) => s.deleteTag);
  const mergeTag = useWorkspaceStore((s) => s.mergeTag);
  const deleteUnusedTags = useWorkspaceStore((s) => s.deleteUnusedTags);

  const [editingTag, setEditingTag] = React.useState<Tag | null>(null);
  const [movingTag, setMovingTag] = React.useState<Tag | null>(null);
  const [movePending, setMovePending] = React.useState(false);
  const [moveError, setMoveError] = React.useState<string | null>(null);
  const [mergingTag, setMergingTag] = React.useState<Tag | null>(null);
  const [deletingTag, setDeletingTag] = React.useState<Tag | null>(null);
  const [unusedDialogOpen, setUnusedDialogOpen] = React.useState(false);
  const [tagActionError, setTagActionError] = React.useState<string | null>(null);

  const { expandedIds, toggle: toggleExpand } = useTagTreeExpansion(tree, selectedTags, query);

  const deletingCount = React.useMemo(
    () => (deletingTag ? countBookmarksWithTag(bookmarks, deletingTag.id) : 0),
    [bookmarks, deletingTag],
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

  // Drop deleted tags from selection
  React.useEffect(() => {
    const tagIds = new Set(tags.map((tag) => tag.id));
    for (const tagId of useBookmarksStore.getState().selectedTags) {
      if (!tagIds.has(tagId)) {
        toggleTag(tagId);
      }
    }
  }, [tags, toggleTag]);

  const handleColorChange = React.useCallback(
    async (id: string, color: string) => {
      const result = await updateTag(id, { color });
      if (result.ok) {
        setTagActionError(null);
        return;
      }
      setTagActionError(
        t(
          result.error === "storage"
            ? "tagAction_errorStorage"
            : result.error === "stale"
              ? "tagAction_errorStale"
              : result.error === "quota"
                ? "tagAction_errorQuota"
                : "tagAction_errorInvalid",
        ),
      );
    },
    [updateTag, t],
  );

  const handleToggleOpen = React.useCallback(() => setOpen((value) => !value), []);
  const handleOpenSearch = React.useCallback(() => {
    setOpen(true);
    setSearchOpen(true);
  }, []);
  const handleCloseSearch = React.useCallback(() => {
    setSearchOpen(false);
    setQuery("");
  }, []);

  const matchingOrAncestorIds = React.useMemo(() => {
    const needle = trimmedQuery.toLowerCase();
    if (!needle) {
      return null;
    }
    const matching = new Set<string>();
    for (const [id, tag] of tree.tagsById) {
      if (tag.name.toLowerCase().includes(needle)) {
        matching.add(id);
        for (const ancestor of tagAncestors(tree, id)) {
          matching.add(ancestor);
        }
      }
    }
    return matching;
  }, [trimmedQuery, tree]);

  const renderTreeNodes = (parentId: string | undefined, depth: number) => {
    const childIds = tree.childrenByParent.get(parentId) ?? [];
    return childIds.map((id) => {
      if (matchingOrAncestorIds && !matchingOrAncestorIds.has(id)) {
        return null;
      }
      const tag = tree.tagsById.get(id);
      if (!tag) {
        return null;
      }
      const children = tree.childrenByParent.get(id) ?? [];
      const hasChildren = children.length > 0;
      const isExpanded = expandedIds.has(id);
      const count = tagCounts.get(id) ?? 0;
      const selected = selectedTags.includes(id);

      return (
        <React.Fragment key={id}>
          <TagTreeRow
            tag={tag}
            depth={depth}
            count={count}
            selected={selected}
            expanded={isExpanded}
            hasChildren={hasChildren}
            query={trimmedQuery}
            onSelect={toggleTag}
            onToggleExpand={toggleExpand}
            onNewChild={(parentTag) => setChildParentTag(parentTag)}
            onMove={(targetTag) => {
              setMovingTag(targetTag);
              setMovePending(false);
              setMoveError(null);
            }}
            onMerge={(targetTag) => setMergingTag(targetTag)}
            onEdit={(targetTag) => setEditingTag(targetTag)}
            onColorChange={handleColorChange}
            onDelete={(targetTag) => setDeletingTag(targetTag)}
          />
          {hasChildren && isExpanded && renderTreeNodes(id, depth + 1)}
        </React.Fragment>
      );
    });
  };

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
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("sidebar_tagActions")}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <MoreHorizontal className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setUnusedDialogOpen(true)}>
                    <Sparkles className="size-4" />
                    {t("sidebar_cleanupUnusedTags")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
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
          <div className="flex flex-col gap-0.5 mt-2 px-1">
            {tags.length === 0 ? (
              <p className="text-xs text-muted-foreground w-full py-1">{t("sidebar_noTagsYet")}</p>
            ) : (
              renderTreeNodes(undefined, 0)
            )}
          </div>
        </SidebarGroupContent>
      )}

      <TagDialog
        open={newTagOpen || childParentTag !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setNewTagOpen(false);
            setChildParentTag(null);
          }
        }}
        initialParentId={childParentTag?.id}
        onSubmit={async ({ name, color, parentId }) => {
          return createTagPath(name, color, parentId);
        }}
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
          onSubmit={async ({ name, color, parentId }) => {
            return updateTag(editingTag.id, { name, color, parentId });
          }}
        />
      )}

      {movingTag && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setMovingTag(null);
              setMovePending(false);
              setMoveError(null);
            }
          }}
        >
          <DialogContent className="sm:max-w-xs" aria-busy={movePending}>
            <DialogHeader>
              <DialogTitle>{t("tagMenu_move")}</DialogTitle>
              <DialogDescription className="sr-only">{t("tagMenu_move")}</DialogDescription>
            </DialogHeader>
            <div className="pt-1">
              <TagTreePicker
                tree={tree}
                value={movingTag.parentId}
                onChange={async (newParentId) => {
                  if (movePending) {
                    return;
                  }
                  setMovePending(true);
                  setMoveError(null);
                  try {
                    const result = await moveTag(movingTag.id, newParentId);
                    if (result.ok) {
                      setMovingTag(null);
                    } else {
                      setMoveError(
                        t(
                          result.error === "storage"
                            ? "tagAction_errorStorage"
                            : result.error === "stale"
                              ? "tagAction_errorStale"
                              : result.error === "depth"
                                ? "tagAction_targetDepth"
                                : result.error === "duplicate"
                                  ? "tagAction_targetDuplicate"
                                  : "tagAction_errorInvalid",
                        ),
                      );
                    }
                  } finally {
                    setMovePending(false);
                  }
                }}
                disabledReason={(candidateId) => {
                  if (movePending) {
                    return "settings_saving";
                  }
                  if (candidateId === movingTag.id) {
                    return "tagAction_targetSelf";
                  }
                  const err = tagTargetError(tree, movingTag.id, candidateId, "move");
                  if (err === "cycle") {
                    return "tagAction_targetDescendant";
                  }
                  if (err === "depth") {
                    return "tagAction_targetDepth";
                  }
                  if (err === "duplicate") {
                    return "tagAction_targetDuplicate";
                  }
                  return undefined;
                }}
                includeTopLevel
                label={t("tagMenu_move")}
              />
              {moveError && (
                <p role="alert" className="text-xs text-destructive mt-2">
                  {moveError}
                </p>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}

      {mergingTag && (
        <TagMergeDialog
          sourceTag={mergingTag}
          onClose={() => setMergingTag(null)}
          onConfirm={async (targetId) => {
            return mergeTag(mergingTag.id, targetId);
          }}
        />
      )}

      {deletingTag && (
        <TagDeleteDialog
          tag={deletingTag}
          bookmarkCount={deletingCount}
          onClose={() => setDeletingTag(null)}
          onConfirm={async () => {
            if (!useWorkspaceStore.getState().tags.some((tag) => tag.id === deletingTag.id)) {
              return { ok: true };
            }
            const result = await deleteTag(deletingTag.id);
            if (!result.ok) {
              return result;
            }
            if (useBookmarksStore.getState().selectedTags.includes(deletingTag.id)) {
              toggleTag(deletingTag.id);
            }
            return result;
          }}
        />
      )}

      {unusedDialogOpen && (
        <UnusedTagsDialog
          onClose={() => setUnusedDialogOpen(false)}
          onConfirm={async () => {
            return deleteUnusedTags();
          }}
        />
      )}
    </SidebarGroup>
  );
}
