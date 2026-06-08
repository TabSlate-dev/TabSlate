import { useState, useEffect } from "react";
import { Loader2, Save } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { useTranslation } from "@/hooks/use-translation";

interface SaveCollectionDialogProps {
  open: boolean;
  defaultName: string;
  tabCount: number;
  isSaving: boolean;
  onConfirm: (name: string, deduplicate: boolean) => void;
  onClose: () => void;
}

export function SaveCollectionDialog({
  open,
  defaultName,
  tabCount,
  isSaving,
  onConfirm,
  onClose,
}: SaveCollectionDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(defaultName);
  const [deduplicate, setDeduplicate] = useState(false);

  useEffect(() => {
    if (open) {
      setName(defaultName);
      setDeduplicate(false); // Default to OFF as requested
    }
  }, [defaultName, open]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("tabsPanel_saveAsCollection")}</DialogTitle>
          <DialogDescription className="sr-only">
            Save {tabCount} tabs as a new collection of bookmarks.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-sm text-muted-foreground">
            {tabCount} tab{tabCount !== 1 ? "s" : ""} will be saved as bookmarks.
          </p>
          <Input
            placeholder="Collection name..."
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onConfirm(name, deduplicate)}
            autoFocus
          />
          <Field orientation="horizontal" className="px-1 pt-1">
            <FieldContent>
              <FieldLabel htmlFor="deduplicate">{t("tabsPanel_deduplicate")}</FieldLabel>
              <FieldDescription>{t("tabsPanel_deduplicateDesc")}</FieldDescription>
            </FieldContent>
            <Switch
              id="deduplicate"
              checked={deduplicate}
              onCheckedChange={setDeduplicate}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => onConfirm(name, deduplicate)} disabled={isSaving}>
            {isSaving ? (
              <Loader2 className="size-4 animate-spin mr-2" />
            ) : (
              <Save className="size-4 mr-2" />
            )}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
