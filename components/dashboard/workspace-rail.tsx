import * as React from "react";
import { Layers, Settings } from "lucide-react";
import { ImportDialog } from "@/components/dashboard/import-dialog";
import { SettingsDialog } from "@/components/dashboard/settings-dialog";
import { WorkspaceManager } from "@/components/dashboard/workspace-manager";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTranslation } from "@/hooks/use-translation";
import { cn } from "@/lib/utils";
import {
  useWorkspaceStore,
  WORKSPACE_COLORS,
  WORKSPACE_GRADIENTS,
} from "@/store/workspace-store";

interface SettingsEventDetail {
  tab?: "general" | "plan" | "account";
}

function isSettingsCustomEvent(event: Event): event is CustomEvent<SettingsEventDetail> {
  return event instanceof CustomEvent;
}

function getInitials(name: string): string {
  const words = name.trim().split(/\s+/);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

export function WorkspaceRail() {
  const { t } = useTranslation();
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const setActiveWorkspaceId = useWorkspaceStore((state) => state.setActiveWorkspaceId);
  const managerButtonRef = React.useRef<HTMLButtonElement>(null);
  const [managerOpen, setManagerOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [importDialogOpen, setImportDialogOpen] = React.useState(false);
  const [settingsTab, setSettingsTab] = React.useState<"general" | "plan" | "account">(
    "general",
  );

  React.useEffect(() => {
    const handleOpenSettings = (event: Event) => {
      const tab = isSettingsCustomEvent(event)
        ? event.detail.tab ?? "general"
        : "general";
      setSettingsTab(tab);
      setSettingsOpen(true);
    };
    const handleOpenImport = () => {
      setImportDialogOpen(true);
    };
    window.addEventListener("tabslate-open-settings", handleOpenSettings);
    window.addEventListener("tabslate-open-import", handleOpenImport);
    return () => {
      window.removeEventListener("tabslate-open-settings", handleOpenSettings);
      window.removeEventListener("tabslate-open-import", handleOpenImport);
    };
  }, []);

  const activeWorkspaces = React.useMemo(
    () => workspaces
      .filter((workspace) => workspace.deletedAt === undefined)
      .sort((first, second) => first.position - second.position),
    [workspaces],
  );

  const handleOpenSettings = React.useCallback(() => {
    setSettingsTab("general");
    setSettingsOpen(true);
  }, []);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-svh w-13 shrink-0 flex-col items-center gap-1.5 border-r border-sidebar-border bg-sidebar py-3">
        <div className="mb-2">
          <div className="flex size-8 items-center justify-center rounded-lg">
            <img src="/wxt.svg" alt="TabSlate" className="size-6" />
          </div>
        </div>

        <div className="flex flex-1 flex-col items-center gap-1.5">
          {activeWorkspaces.map((workspace) => {
            const workspaceColor = WORKSPACE_COLORS.find(
              (color) => color === workspace.color,
            );
            const gradient = workspaceColor
              ? WORKSPACE_GRADIENTS[workspaceColor]
              : "from-gray-400 to-gray-500";
            return (
              <Tooltip key={workspace.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("workspaceManager_switchTo", [workspace.name])}
                    onClick={() => setActiveWorkspaceId(workspace.id)}
                    className={cn(
                      "flex size-8 items-center justify-center rounded-lg bg-linear-to-br text-[11px] font-semibold text-white shadow-sm ring-offset-sidebar transition-all",
                      gradient,
                      activeWorkspaceId === workspace.id
                        ? "ring-2 ring-primary ring-offset-2"
                        : "opacity-60 hover:opacity-100",
                    )}
                  >
                    {getInitials(workspace.name)}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">{workspace.name}</TooltipContent>
              </Tooltip>
            );
          })}

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                ref={managerButtonRef}
                type="button"
                aria-label={t("workspaceManager_open")}
                onClick={() => setManagerOpen(true)}
                className="flex size-8 items-center justify-center rounded-lg border-2 border-dashed border-sidebar-border text-muted-foreground transition-colors hover:border-primary hover:text-primary"
              >
                <Layers className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{t("workspaceManager_open")}</TooltipContent>
          </Tooltip>
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t("settings_title")}
              onClick={handleOpenSettings}
              className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Settings className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{t("settings_title")}</TooltipContent>
        </Tooltip>
      </div>

      <WorkspaceManager
        open={managerOpen}
        returnFocusRef={managerButtonRef}
        onOpenChange={setManagerOpen}
      />
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        initialTab={settingsTab}
      />
      <ImportDialog open={importDialogOpen} onOpenChange={setImportDialogOpen} />
    </TooltipProvider>
  );
}
