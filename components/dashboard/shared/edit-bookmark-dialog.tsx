import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import type { Bookmark } from "@/lib/types";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useTranslation } from "@/hooks/use-translation";

interface EditBookmarkDialogProps {
  bookmark: Bookmark;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditBookmarkDialog({ bookmark, open, onOpenChange }: EditBookmarkDialogProps) {
  const { t } = useTranslation();
  const updateBookmark = useBookmarksStore(s => s.updateBookmark);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("editBookmarkDialog_title")}</DialogTitle>
          <DialogDescription className="sr-only">
            {t("editBookmarkDialog_desc")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4 pt-1"
          action={(formData) => {
            const title = formData.get("title") as string;
            const url = formData.get("url") as string;
            const description = formData.get("description") as string;
            if (!title?.trim() || !url?.trim()) { return; }
            updateBookmark(bookmark.id, { 
              title: title.trim(), 
              url: url.trim(), 
              description: description.trim() 
            });
            onOpenChange(false);
          }}
        >
          <Field>
            <FieldLabel htmlFor="edit-title">{t("editBookmarkDialog_titleField")}</FieldLabel>
            <Input
              id="edit-title"
              name="title"
              defaultValue={bookmark.title}
              required
              autoFocus
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="edit-url">{t("editBookmarkDialog_urlField")}</FieldLabel>
            <Input
              id="edit-url"
              name="url"
              type="url"
              defaultValue={bookmark.url}
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="edit-description">{t("editBookmarkDialog_descField")}</FieldLabel>
            <Input
              id="edit-description"
              name="description"
              defaultValue={bookmark.description || ""}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t("editBookmarkDialog_cancel")}
            </Button>
            <Button type="submit" size="sm">
              {t("editBookmarkDialog_save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
