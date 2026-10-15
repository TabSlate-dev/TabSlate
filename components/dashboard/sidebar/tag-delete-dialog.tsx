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
  onConfirm: () => void;
}

export function TagDeleteDialog({ tag, bookmarkCount, onClose, onConfirm }: TagDeleteDialogProps) {
  const { t } = useTranslation();
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
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            {t("settings_cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {t("tagDeleteDialog_confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
