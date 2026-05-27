import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useWorkspaceStore } from "@/store/workspace-store";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus } from "lucide-react";
import { TagDialog } from "@/components/dashboard/sidebar/tag-dialog";
import type { Bookmark } from "@/lib/types";
import { useTranslation } from "@/hooks/use-translation";

interface BookmarkTagsDialogProps {
  bookmark: Bookmark;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BookmarkTagsDialog({ bookmark, open, onOpenChange }: BookmarkTagsDialogProps) {
  const { t } = useTranslation();
  const tags = useWorkspaceStore(s => s.tags);
  const createTag = useWorkspaceStore(s => s.createTag);
  const updateBookmark = useBookmarksStore(s => s.updateBookmark);
  const [selected, setSelected] = React.useState<Set<string>>(new Set(bookmark.tags));
  const [newTagOpen, setNewTagOpen] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setSelected(new Set(bookmark.tags));
    }
  }, [open, bookmark.tags]);

  const handleToggle = (tagId: string, checked: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      checked ? next.add(tagId) : next.delete(tagId);
      return next;
    });
  };

  const handleSave = () => {
    updateBookmark(bookmark.id, { tags: Array.from(selected) });
    onOpenChange(false);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>{t("bookmarkTagsDialog_title")}</DialogTitle>
          <DialogDescription className="sr-only">
            {t("bookmarkTagsDialog_desc")}
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-3 py-4 max-h-[60vh] overflow-y-auto">
          {tags.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-4">
              {t("bookmarkTagsDialog_noTags")}
            </div>
          ) : (
            tags.map(tag => (
              <div key={tag.id} className="flex items-center space-x-2">
                <Checkbox 
                  id={`tag-${tag.id}`} 
                  checked={selected.has(tag.id)} 
                  onCheckedChange={(checked) => handleToggle(tag.id, checked as boolean)} 
                />
                <label
                  htmlFor={`tag-${tag.id}`}
                  className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed flex items-center gap-2 cursor-pointer"
                >
                  <span className={`inline-block size-3 rounded-full ${tag.color.split(" ")[0].replace("/10", "")}`} />
                  {tag.name}
                </label>
              </div>
            ))
          )}
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-muted-foreground mt-2"
            onClick={() => setNewTagOpen(true)}
          >
            <Plus className="size-4 mr-2" />
            {t("bookmarkTagsDialog_createTag")}
          </Button>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("bookmarkTagsDialog_cancel")}
          </Button>
          <Button type="button" size="sm" onClick={handleSave}>
            {t("bookmarkTagsDialog_save")}
          </Button>
        </DialogFooter>
      </DialogContent>
      </Dialog>
      <TagDialog
        open={newTagOpen}
        onOpenChange={setNewTagOpen}
        onSubmit={(name, color) => {
          const newTag = createTag(name, color);
          handleToggle(newTag.id, true);
        }}
      />
    </>
  );
}
