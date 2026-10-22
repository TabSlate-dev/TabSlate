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

interface TagDeleteDialogProps {
  tag: Tag;
  /** Active bookmarks in every workspace that carry the tag. */
  bookmarkCount: number;
  onClose: () => void;
  onConfirm: () => Promise<TagActionResult>;
}

export function TagDeleteDialog({ tag, bookmarkCount, onClose, onConfirm }: TagDeleteDialogProps) {
  const { t } = useTranslation();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
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
            {t(bookmarkCount === 1 ? "tagDeleteDialog_desc_one" : "tagDeleteDialog_desc_other", [String(bookmarkCount)])}
          </DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
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
              if (pending) { return; }
              setPending(true);
              try {
                const result = await onConfirm();
                if (!result.ok) {
                  setError(t(result.error === "storage" ? "tagAction_errorStorage" : result.error === "stale" ? "tagAction_errorStale" : "tagAction_errorInvalid"));
                  return;
                }
                onClose();
              } finally { setPending(false); }
            }}
          >
            {t("tagDeleteDialog_confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
