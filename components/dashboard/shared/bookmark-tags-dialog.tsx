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
import type { Bookmark } from "@/lib/types";

interface BookmarkTagsDialogProps {
  bookmark: Bookmark;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BookmarkTagsDialog({ bookmark, open, onOpenChange }: BookmarkTagsDialogProps) {
  const { tags } = useWorkspaceStore();
  const updateBookmark = useBookmarksStore(s => s.updateBookmark);
  const [selected, setSelected] = React.useState<Set<string>>(new Set(bookmark.tags));

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>Manage Tags</DialogTitle>
          <DialogDescription className="sr-only">
            Select tags for this bookmark.
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-3 py-4 max-h-[60vh] overflow-y-auto">
          {tags.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-4">
              No tags available. Create tags in the sidebar first.
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
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={handleSave}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
