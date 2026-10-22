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
import type { Tag } from "@/lib/types";
import { useTagTree } from "@/hooks/use-tag-tree";
import { planTagDeletion } from "@/lib/tag-mutations";

interface TagDeleteDialogProps {
  tag: Tag;
  /** Active bookmarks in every workspace that carry the tag. */
  bookmarkCount: number;
  onClose: () => void;
  onConfirm: () => Promise<TagActionResult>;
}

export function TagDeleteDialog({ tag, bookmarkCount, onClose, onConfirm }: TagDeleteDialogProps) {
  const { t } = useTranslation();
  const tree = useTagTree();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const deletionPreview = React.useMemo(() => {
    const result = planTagDeletion(tree, [tag.id], Date.now());
    if (!result.ok) {
      return { promotedCount: 0, renames: [] };
    }
    const immediateChildren = tree.childrenByParent.get(tag.id) ?? [];
    const promotedCount = immediateChildren.length;
    const renames = result.plan.upserts
      .filter((u) => {
        const original = tree.tagsById.get(u.id);
        return original && original.name !== u.name;
      })
      .map((u) => {
        const original = tree.tagsById.get(u.id);
        return { from: original?.name ?? "", to: u.name };
      });
    return { promotedCount, renames };
  }, [tree, tag.id]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("tagDeleteDialog_title", [tag.name])}</DialogTitle>
          <DialogDescription>
            {t(bookmarkCount === 1 ? "tagDeleteDialog_desc_one" : "tagDeleteDialog_desc_other", [
              String(bookmarkCount),
            ])}
          </DialogDescription>
        </DialogHeader>

        {deletionPreview.promotedCount > 0 && (
          <p className="text-xs text-muted-foreground">
            {t(
              deletionPreview.promotedCount === 1
                ? "tagDeleteDialog_promoted_one"
                : "tagDeleteDialog_promoted_other",
              [String(deletionPreview.promotedCount)],
            )}
          </p>
        )}

        {deletionPreview.renames.length > 0 && (
          <div className="text-xs text-muted-foreground space-y-0.5">
            {deletionPreview.renames.map((r, i) => (
              <p key={i}>{t("tagDeleteDialog_renames_preview", [r.from, r.to])}</p>
            ))}
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
            disabled={pending}
            aria-busy={pending}
            onClick={async () => {
              if (pending) {
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
            {t("tagDeleteDialog_confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
