import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslation } from "@/hooks/use-translation";

interface OpenTabsConfirmDialogProps {
  count: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function OpenTabsConfirmDialog({ count, open, onOpenChange, onConfirm }: OpenTabsConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("bulkActions_confirmOpenTitle", [String(count)])}</DialogTitle>
          <DialogDescription>{t("bulkActions_confirmOpenDesc")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("settings_cancel")}
          </Button>
          <Button type="button" size="sm" onClick={onConfirm}>
            {t("bulkActions_confirmOpen")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
