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
import { useTranslation } from "@/hooks/use-translation";

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
  const { t } = useTranslation();
  const [icon, setIcon] = React.useState(initial?.icon ?? "folder");

  React.useEffect(() => {
    if (open) {
      setIcon(initial?.icon ?? "folder");
    }
  }, [open, initial]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLFormElement>) => {
    if (event.nativeEvent.isComposing || !(event.target instanceof Element) || event.target.closest("form") !== event.currentTarget) {
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.requestSubmit();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>{t(initial ? "collectionDialog_editTitle" : "collectionDialog_newTitle")}</DialogTitle>
          <DialogDescription className="sr-only">
            {t(initial ? "collectionDialog_editDesc" : "collectionDialog_newDesc")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4 pt-1"
          onKeyDown={handleKeyDown}
          action={(formData) => {
            const name = formData.get("name") as string;
            if (!name?.trim()) { return; }
            onSubmit(name.trim(), icon);
            onOpenChange(false);
          }}
        >
          <Field>
            <FieldLabel htmlFor="collection-name">{t("collectionDialog_nameLabel")}</FieldLabel>
            <Input
              id="collection-name"
              name="name"
              defaultValue={initial?.name ?? ""}
              placeholder={t("collectionDialog_namePlaceholder")}
              autoFocus
              required
            />
          </Field>
          <Field>
            <FieldLabel>{t("collectionDialog_iconLabel")}</FieldLabel>
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
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t("settings_cancel")}
            </Button>
            <Button type="submit" size="sm">
              {t(initial ? "collectionDialog_save" : "collectionDialog_create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
