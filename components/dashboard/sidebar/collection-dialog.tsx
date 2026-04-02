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
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Bookmark,
  BookOpen,
  Code,
  Folder,
  Globe,
  Heart,
  Palette,
  Sparkles,
  Star,
  Wrench,
  Inbox,
} from "lucide-react";
import { COLLECTION_ICONS } from "@/store/workspace-store";
import type { Collection } from "@/lib/types";

const ICON_MAP: Record<string, React.ElementType> = {
  folder: Folder,
  bookmark: Bookmark,
  code: Code,
  palette: Palette,
  wrench: Wrench,
  "book-open": BookOpen,
  sparkles: Sparkles,
  star: Star,
  heart: Heart,
  globe: Globe,
  inbox: Inbox,
};

interface CollectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: Collection;
  onSubmit: (name: string, icon: string) => void;
}

export function CollectionDialog({ open, onOpenChange, initial, onSubmit }: CollectionDialogProps) {
  const [icon, setIcon] = React.useState(initial?.icon ?? "folder");

  React.useEffect(() => {
    if (open) {
      setIcon(initial?.icon ?? "folder");
    }
  }, [open, initial]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit Collection" : "New Collection"}</DialogTitle>
          <DialogDescription className="sr-only">
            {initial
              ? "Edit the name and icon of this collection."
              : "Create a new collection to organize your bookmarks."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4 pt-1"
          action={(formData) => {
            const name = formData.get("name") as string;
            if (!name?.trim()) { return; }
            onSubmit(name.trim(), icon);
            onOpenChange(false);
          }}
        >
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Name</label>
            <Input
              name="name"
              defaultValue={initial?.name ?? ""}
              placeholder="My Collection"
              autoFocus
              required
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Icon</label>
            <div className="flex flex-wrap gap-1.5">
              {COLLECTION_ICONS.map((ic) => {
                const Icon = ICON_MAP[ic] ?? Folder;
                return (
                  <button
                    key={ic}
                    type="button"
                    onClick={() => setIcon(ic)}
                    className={cn(
                      "size-8 rounded-md flex items-center justify-center transition-colors",
                      icon === ic
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted hover:bg-muted/80 text-muted-foreground"
                    )}
                  >
                    <Icon className="size-4" />
                  </button>
                );
              })}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm">
              {initial ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
