import { useState, useEffect } from "react";
import { AlertCircle, Loader2, Save } from "lucide-react";
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
import { useWorkspaceStore } from "@/store/workspace-store";
import { isActiveWorkspace } from "@/lib/workspace-visibility";
import { Alert, AlertDescription } from "@/components/ui/alert";

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
  const [targetUnavailable, setTargetUnavailable] = useState(false);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);

  useEffect(() => {
    if (open) {
      setName(defaultName);
      setDeduplicate(false); // Default to OFF as requested
      setTargetUnavailable(false);
    }
  }, [defaultName, open]);

  const handleConfirm = () => {
    const state = useWorkspaceStore.getState();
    const activeWorkspace = state.workspaces.find(
      (workspace) => workspace.id === state.activeWorkspaceId,
    );
    if (!isActiveWorkspace(activeWorkspace)) {
      setTargetUnavailable(true);
      return;
    }
    setTargetUnavailable(false);
    onConfirm(name, deduplicate);
  };

  const targetIsActive = workspaces.some(
    (workspace) => workspace.id === activeWorkspaceId && isActiveWorkspace(workspace),
  );

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("tabsPanel_saveAsCollection")}</DialogTitle>
          <DialogDescription className="sr-only">
            {t("tabsPanel_saveCollectionDesc", [tabCount.toString()])}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {(targetUnavailable || !targetIsActive) && (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertDescription>{t("workspaceVisibility_targetUnavailable")}</AlertDescription>
            </Alert>
          )}
          <p className="text-sm text-muted-foreground">
            {t(tabCount === 1 ? "tabsPanel_saveCollectionCount_one" : "tabsPanel_saveCollectionCount_other", [tabCount.toString()])}
          </p>
          <Input
            placeholder={t("tabsPanel_collectionNamePlaceholder")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleConfirm()}
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
            {t("groupsPanel_cancel")}
          </Button>
          <Button size="sm" onClick={handleConfirm} disabled={isSaving || !targetIsActive}>
            {isSaving ? (
              <Loader2 className="size-4 animate-spin mr-2" />
            ) : (
              <Save className="size-4 mr-2" />
            )}
            {t("tabsPanel_save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
