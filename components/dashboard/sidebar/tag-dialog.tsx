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
import { TAG_COLORS } from "@/store/workspace-store";

interface TagDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (name: string, color: string) => void;
}

export function TagDialog({ open, onOpenChange, onSubmit }: TagDialogProps) {
  const [color, setColor] = React.useState<string>(TAG_COLORS[0]);

  React.useEffect(() => {
    if (open) {
      setColor(TAG_COLORS[0]);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>New Tag</DialogTitle>
          <DialogDescription className="sr-only">
            Create a new tag to label your bookmarks.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4 pt-1"
          action={(formData) => {
            const name = formData.get("name") as string;
            if (!name?.trim()) return;
            onSubmit(name.trim(), color);
            onOpenChange(false);
          }}
        >
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Name</label>
            <Input
              name="name"
              defaultValue=""
              placeholder="Tag name"
              autoFocus
              required
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Color</label>
            <div className="flex flex-wrap gap-1.5">
              {TAG_COLORS.map((c) => {
                const bgColor = c.split(" ")[0];
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    className={cn(
                      "size-7 rounded-full transition-all",
                      bgColor.replace("/10", ""),
                      color === c ? "ring-2 ring-primary ring-offset-2" : "opacity-50 hover:opacity-100"
                    )}
                  />
                );
              })}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm">
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
