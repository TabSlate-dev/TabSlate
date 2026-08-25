import { useRef, type RefObject } from "react";
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
import { useTranslation } from "@/hooks/use-translation";
import type { WorkspaceDeleteConfirmation } from "./model";

export interface DeleteWorkspaceDialogProps {
  open: boolean;
  confirmation: WorkspaceDeleteConfirmation | null;
  retentionLabel: string;
  errorMessage: string | null;
  busy: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
}

function countMessage(
  count: number,
  singularKey: string,
  pluralKey: string,
  t: (key: string, substitutions?: string | string[]) => string,
): string {
  return t(count === 1 ? singularKey : pluralKey, [count.toString()]);
}

export function DeleteWorkspaceDialog({
  open,
  confirmation,
  retentionLabel,
  errorMessage,
  busy,
  returnFocusRef,
  onOpenChange,
  onConfirm,
}: DeleteWorkspaceDialogProps) {
  const { t } = useTranslation();
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelButtonRef.current?.focus();
        }}
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
          <DialogTitle>{t("workspaceManager_deleteDialogTitle")}</DialogTitle>
          <DialogDescription>
            {confirmation
              ? t("workspaceManager_deleteDialogDescription", [confirmation.workspaceName])
              : t("workspaceManager_deleteDialogDescriptionFallback")}
          </DialogDescription>
        </DialogHeader>

        {confirmation && (
          <div className="space-y-3">
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>{countMessage(
                confirmation.counts.collections,
                "workspaceManager_collectionCount_one",
                "workspaceManager_collectionCount_other",
                t,
              )}</li>
              <li>{countMessage(
                confirmation.counts.bookmarks,
                "workspaceManager_bookmarkCount_one",
                "workspaceManager_bookmarkCount_other",
                t,
              )}</li>
              <li>{countMessage(
                confirmation.counts.savedGroups,
                "workspaceManager_groupCount_one",
                "workspaceManager_groupCount_other",
                t,
              )}</li>
            </ul>
            <p className="text-sm text-muted-foreground">{retentionLabel}</p>
            <Alert>
              <AlertTriangle />
              <AlertDescription>
                {t(confirmation.quotaMessageKey)}
              </AlertDescription>
            </Alert>
          </div>
        )}

        {errorMessage && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button
            ref={cancelButtonRef}
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
            disabled={busy || confirmation === null}
            onClick={onConfirm}
          >
            {busy
              ? t("workspaceManager_deleting")
              : t("workspaceManager_confirmDelete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
