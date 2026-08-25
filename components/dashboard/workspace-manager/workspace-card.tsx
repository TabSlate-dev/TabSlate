import * as React from "react";
import { Palette, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import type { Workspace } from "@/lib/types";
import {
  WORKSPACE_COLORS,
  WORKSPACE_GRADIENTS,
} from "@/store/workspace-store";
import { useTranslation } from "@/hooks/use-translation";
import type { WorkspaceAggregateCounts } from "./model";

export interface WorkspaceCardProps {
  workspace: Workspace;
  counts: WorkspaceAggregateCounts;
  retentionLabel: string;
  canDelete: boolean;
  isActive?: boolean;
  deleteDisabledReason?: string;
  restoreDisabledReason?: string;
  purgeDisabledReason?: string;
  onSwitch(workspaceId: string): void;
  onRename(workspaceId: string): void;
  onRecolor(workspaceId: string): void;
  onDelete(workspaceId: string): void;
  onRestore(workspaceId: string): void;
  onPermanentlyDelete(workspaceId: string): void;
}

function countLabel(
  count: number,
  singularKey: string,
  pluralKey: string,
  t: (key: string, substitutions?: string | string[]) => string,
): string {
  return t(count === 1 ? singularKey : pluralKey, [count.toString()]);
}

export const WorkspaceCard = React.memo(function WorkspaceCard({
  workspace,
  counts,
  retentionLabel,
  canDelete,
  isActive = false,
  deleteDisabledReason,
  restoreDisabledReason,
  purgeDisabledReason,
  onSwitch,
  onRename,
  onRecolor,
  onDelete,
  onRestore,
  onPermanentlyDelete,
}: WorkspaceCardProps) {
  const { t } = useTranslation();
  const deleted = workspace.deletedAt !== undefined;
  const workspaceColor = WORKSPACE_COLORS.find((color) => color === workspace.color);
  const gradient = workspaceColor
    ? WORKSPACE_GRADIENTS[workspaceColor]
    : "from-gray-400 to-gray-500";
  const disabledReason = deleted
    ? restoreDisabledReason ?? purgeDisabledReason
    : deleteDisabledReason;

  return (
    <article className="rounded-lg border bg-card p-4 text-card-foreground">
      <div className="flex items-start gap-3">
        <div
          aria-hidden="true"
          className={cn("mt-0.5 size-9 shrink-0 rounded-lg bg-linear-to-br", gradient)}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-medium">{workspace.name}</h3>
            {isActive && (
              <span className="text-xs text-muted-foreground">
                {t("workspaceManager_current")}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {countLabel(
              counts.collections,
              "workspaceManager_collectionCount_one",
              "workspaceManager_collectionCount_other",
              t,
            )}
            {" · "}
            {countLabel(
              counts.bookmarks,
              "workspaceManager_bookmarkCount_one",
              "workspaceManager_bookmarkCount_other",
              t,
            )}
            {" · "}
            {countLabel(
              counts.savedGroups,
              "workspaceManager_groupCount_one",
              "workspaceManager_groupCount_other",
              t,
            )}
          </p>
          {deleted && (
            <div className="mt-2 space-y-1 text-xs text-muted-foreground">
              {workspace.deletedAt !== undefined && (
                <p>{t("workspaceManager_deletedAt", [
                  new Intl.DateTimeFormat().format(new Date(workspace.deletedAt)),
                ])}</p>
              )}
              <p>{retentionLabel}</p>
              <p className="font-medium text-foreground">
                {t("workspaceManager_stillCountsTowardQuota")}
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {!deleted && (
          <>
            <Button
              type="button"
              size="sm"
              variant={isActive ? "secondary" : "outline"}
              disabled={isActive}
              onClick={() => onSwitch(workspace.id)}
            >
              {isActive
                ? t("workspaceManager_current")
                : t("workspaceManager_switch")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onRename(workspace.id)}
            >
              <Pencil className="size-3.5" />
              {t("workspaceManager_rename")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onRecolor(workspace.id)}
            >
              <Palette className="size-3.5" />
              {t("workspaceManager_recolor")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="text-destructive hover:text-destructive"
              disabled={!canDelete}
              onClick={() => onDelete(workspace.id)}
            >
              <Trash2 className="size-3.5" />
              {t("workspaceManager_delete")}
            </Button>
          </>
        )}
        {deleted && (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={restoreDisabledReason !== undefined}
              onClick={() => onRestore(workspace.id)}
            >
              <RotateCcw className="size-3.5" />
              {t("workspaceManager_restore")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={purgeDisabledReason !== undefined}
              onClick={() => onPermanentlyDelete(workspace.id)}
            >
              <Trash2 className="size-3.5" />
              {t("workspaceManager_permanentlyDelete")}
            </Button>
          </>
        )}
      </div>

      {disabledReason && (
        <Alert className="mt-3">
          <AlertDescription>{disabledReason}</AlertDescription>
        </Alert>
      )}
    </article>
  );
});
