import * as React from "react";
import type { TagActionResult } from "@/lib/tag-mutations";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/hooks/use-translation";
import type { Bookmark, Tag } from "@/lib/types";
import { useTagTree } from "@/hooks/use-tag-tree";
import { planTagMerge, tagTargetError } from "@/lib/tag-mutations";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { TagTreePicker } from "@/components/dashboard/shared/tag-tree-picker";

interface TagMergeDialogProps {
  sourceTag: Tag;
  onClose: () => void;
  onConfirm: (targetTagId: string) => Promise<TagActionResult>;
}

export function TagMergeDialog({ sourceTag, onClose, onConfirm }: TagMergeDialogProps) {
  const { t } = useTranslation();
  const tree = useTagTree();
  const [targetId, setTargetId] = React.useState<string | undefined>(undefined);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [loadingCounts, setLoadingCounts] = React.useState(true);

  const bookmarks = useBookmarksStore((s) => s.bookmarks);
  const archivedBookmarks = useBookmarksStore((s) => s.archivedBookmarks);
  const trashedBookmarks = useBookmarksStore((s) => s.trashedBookmarks);
  const loadArchived = useBookmarksStore((s) => s.loadArchivedBookmarks);
  const loadTrashed = useBookmarksStore((s) => s.loadTrashedBookmarks);

  React.useEffect(() => {
    let active = true;
    const state = useBookmarksStore.getState();
    const tasks: Promise<void>[] = [];
    if (!state._archivedLoaded) {
      tasks.push(loadArchived());
    }
    if (!state._trashedLoaded) {
      tasks.push(loadTrashed());
    }
    if (tasks.length === 0) {
      setLoadingCounts(false);
      return;
    }
    Promise.all(tasks)
      .then(() => {
        if (active) {
          setLoadingCounts(false);
        }
      })
      .catch(() => {
        if (active) {
          setLoadingCounts(false);
        }
      });
    return () => {
      active = false;
    };
  }, [loadArchived, loadTrashed]);

  const disabledReason = React.useCallback(
    (candidateId: string | undefined): string | undefined => {
      if (!candidateId) {
        return "tagAction_targetSelf";
      }
      if (candidateId === sourceTag.id) {
        return "tagAction_targetSelf";
      }
      const err = tagTargetError(tree, sourceTag.id, candidateId, "merge");
      if (err === "cycle") {
        return "tagAction_targetDescendant";
      }
      if (err === "depth") {
        return "tagAction_targetDepth";
      }
      return undefined;
    },
    [sourceTag.id, tree],
  );

  const mergePreview = React.useMemo(() => {
    if (!targetId || targetId === sourceTag.id) {
      return null;
    }
    const result = planTagMerge(tree, sourceTag.id, targetId, Date.now());
    if (!result.ok) {
      return null;
    }
    const replacedIds = new Set(result.plan.replacements.keys());
    replacedIds.add(sourceTag.id);

    const countMatches = (list: Iterable<Bookmark>) => {
      let count = 0;
      for (const bookmark of list) {
        if (bookmark.tags.some((tagId) => replacedIds.has(tagId))) {
          count += 1;
        }
      }
      return count;
    };

    const affectedCount =
      countMatches(bookmarks.values()) +
      countMatches(archivedBookmarks) +
      countMatches(trashedBookmarks);

    const descendantReplacements = Math.max(0, result.plan.replacements.size - 1);
    return { affectedCount, descendantReplacements };
  }, [targetId, sourceTag.id, tree, bookmarks, archivedBookmarks, trashedBookmarks]);

  const canConfirm = targetId !== undefined && !loadingCounts && !pending;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("tagMergeDialog_title", [sourceTag.name])}</DialogTitle>
          <DialogDescription className="sr-only">
            {t("tagMergeDialog_targetLabel")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <TagTreePicker
            tree={tree}
            value={targetId}
            onChange={(selectedId) => {
              setTargetId(selectedId);
              setError(null);
            }}
            disabledReason={disabledReason}
            includeTopLevel={false}
            label={t("tagMergeDialog_targetLabel")}
          />

          {targetId && (
            <div className="rounded border p-2 bg-muted/20 text-xs text-muted-foreground space-y-1">
              {loadingCounts ? (
                <p>{t("tagMergeDialog_loadingCounts")}</p>
              ) : mergePreview ? (
                <>
                  <p>
                    {t(
                      mergePreview.affectedCount === 1
                        ? "tagMergeDialog_affectedBookmarks_one"
                        : "tagMergeDialog_affectedBookmarks_other",
                      [String(mergePreview.affectedCount)],
                    )}
                  </p>
                  {mergePreview.descendantReplacements > 0 && (
                    <p>
                      {t("tagMergeDialog_descendantNotice", [
                        String(mergePreview.descendantReplacements),
                      ])}
                    </p>
                  )}
                </>
              ) : null}
            </div>
          )}

          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            {t("settings_cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!canConfirm}
            aria-busy={pending}
            onClick={async () => {
              if (!targetId || pending) {
                return;
              }
              setPending(true);
              try {
                const result = await onConfirm(targetId);
                if (!result.ok) {
                  setError(
                    t(
                      result.error === "storage"
                        ? "tagAction_errorStorage"
                        : result.error === "stale"
                          ? "tagAction_errorStale"
                          : result.error === "depth"
                            ? "tagAction_targetDepth"
                            : "tagAction_errorInvalid",
                    ),
                  );
                  return;
                }
                onClose();
              } finally {
                setPending(false);
              }
            }}
          >
            {t("tagMergeDialog_confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
