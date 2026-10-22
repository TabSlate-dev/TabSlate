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
import { useTagTree } from "@/hooks/use-tag-tree";
import { unusedTagIds } from "@/lib/tag-counts";
import { displayTagPath } from "@/lib/tag-tree";
import { useBookmarksStore } from "@/store/bookmarks-store";

interface UnusedTagsDialogProps {
  onClose: () => void;
  onConfirm: () => Promise<TagActionResult>;
}

export function UnusedTagsDialog({ onClose, onConfirm }: UnusedTagsDialogProps) {
  const { t } = useTranslation();
  const tree = useTagTree();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const bookmarks = useBookmarksStore((s) => s.bookmarks);
  const archivedBookmarks = useBookmarksStore((s) => s.archivedBookmarks);
  const trashedBookmarks = useBookmarksStore((s) => s.trashedBookmarks);
  const loadArchived = useBookmarksStore((s) => s.loadArchivedBookmarks);
  const loadTrashed = useBookmarksStore((s) => s.loadTrashedBookmarks);

  React.useEffect(() => {
    const state = useBookmarksStore.getState();
    if (!state._archivedLoaded) {
      void loadArchived();
    }
    if (!state._trashedLoaded) {
      void loadTrashed();
    }
  }, [loadArchived, loadTrashed]);

  const unusedPaths = React.useMemo(() => {
    const allBookmarks = [
      ...bookmarks.values(),
      ...archivedBookmarks,
      ...trashedBookmarks,
    ];
    const unused = unusedTagIds(tree, allBookmarks);
    const paths = Array.from(unused)
      .map((id) => displayTagPath(tree, id))
      .filter((path) => path.length > 0);
    const collator = new Intl.Collator(tree.locale, { sensitivity: "base" });
    paths.sort((a, b) => collator.compare(a, b));
    return paths;
  }, [tree, bookmarks, archivedBookmarks, trashedBookmarks]);

  const displayedPaths = unusedPaths.slice(0, 10);
  const remainderCount = Math.max(0, unusedPaths.length - 10);
  const isEmpty = unusedPaths.length === 0;

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
          <DialogTitle>{t("unusedTagsDialog_title")}</DialogTitle>
          <DialogDescription>
            {isEmpty ? t("unusedTagsDialog_empty") : t("unusedTagsDialog_desc")}
          </DialogDescription>
        </DialogHeader>

        {!isEmpty && (
          <div className="max-h-48 overflow-y-auto rounded border p-2 space-y-1 text-xs font-mono bg-muted/20">
            {displayedPaths.map((path, index) => (
              <p key={index} className="truncate">
                {path}
              </p>
            ))}
            {remainderCount > 0 && (
              <p className="text-muted-foreground font-sans italic pt-1">
                {t("unusedTagsDialog_remainder", [String(remainderCount)])}
              </p>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            {t("settings_cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            data-dialog-confirm="true"
            disabled={isEmpty || pending}
            aria-busy={pending}
            onClick={async () => {
              if (isEmpty || pending) {
                return;
              }
              setPending(true);
              try {
                const result = await onConfirm();
                if (!result.ok) {
                  setError(
                    t(
                      result.error === "storage"
                        ? "tagAction_errorStorage"
                        : result.error === "stale"
                          ? "tagAction_errorStale"
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
            {t("unusedTagsDialog_confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
