import { useEffect, useState, type RefObject } from "react";
import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/hooks/use-translation";
import type { Workspace } from "@/lib/types";
import { canConfirmPermanentDelete } from "./model";

export interface PermanentDeleteWorkspaceDialogProps {
  open: boolean;
  workspace: Workspace | null;
  errorMessage: string | null;
  disabledReason: string | null;
  busy: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
}

export function PermanentDeleteWorkspaceDialog({
  open,
  workspace,
  errorMessage,
  disabledReason,
  busy,
  returnFocusRef,
  onOpenChange,
  onConfirm,
}: PermanentDeleteWorkspaceDialogProps) {
  const { t } = useTranslation();
  const [typedName, setTypedName] = useState("");

  useEffect(() => {
    if (open) {
      setTypedName("");
    }
  }, [open, workspace?.id]);

  const canConfirm = workspace !== null
    && disabledReason === null
    && canConfirmPermanentDelete(typedName, workspace.name);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocusRef.current?.isConnected) {
            returnFocusRef.current.focus();
            return;
          }
          document.getElementById("workspace-manager-tab-deleted")?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("workspaceManager_permanentDialogTitle")}</DialogTitle>
          <DialogDescription>
            {workspace
              ? t("workspaceManager_permanentDialogDescription", [workspace.name])
              : t("workspaceManager_permanentDialogDescriptionFallback")}
          </DialogDescription>
        </DialogHeader>

        {workspace && (
          <Field>
            <FieldLabel htmlFor="workspace-permanent-delete-name">
              {t("workspaceManager_typeName", [workspace.name])}
            </FieldLabel>
            <Input
              id="workspace-permanent-delete-name"
              value={typedName}
              autoComplete="off"
              autoFocus
              onChange={(event) => setTypedName(event.target.value)}
            />
          </Field>
        )}

        {(disabledReason || errorMessage) && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertDescription>{disabledReason ?? errorMessage}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {t("workspaceManager_cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={!canConfirm || busy}
            onClick={onConfirm}
          >
            {busy
              ? t("workspaceManager_deletingPermanently")
              : t("workspaceManager_confirmPermanentDelete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
