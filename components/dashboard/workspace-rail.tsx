import * as React from "react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { Layers, MoreHorizontal, Pencil, Plus, Settings, Trash2 } from "lucide-react";
import {
  useWorkspaceStore,
  WORKSPACE_COLORS,
  WORKSPACE_GRADIENTS,
  type WorkspaceColor,
} from "@/store/workspace-store";
import type { Workspace } from "@/lib/types";
import { SettingsDialog } from "@/components/dashboard/settings-dialog";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInitials(name: string): string {
  const words = name.trim().split(/\s+/);
  if (words.length >= 2) { return (words[0][0] + words[1][0]).toUpperCase(); }
  return name.slice(0, 2).toUpperCase();
}

// ---------------------------------------------------------------------------
// WorkspaceDialog (create + edit)
// ---------------------------------------------------------------------------

interface WorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: Workspace;
  onSubmit: (name: string, color: string) => void;
}

function WorkspaceDialog({
  open,
  onOpenChange,
  initial,
  onSubmit,
}: WorkspaceDialogProps) {
  const [name, setName] = React.useState(initial?.name ?? "");
  const [color, setColor] = React.useState<WorkspaceColor>(
    (initial?.color as WorkspaceColor) ?? "blue"
  );

  React.useEffect(() => {
    if (open) {
      setName(initial?.name ?? "");
      setColor((initial?.color as WorkspaceColor) ?? "blue");
    }
  }, [open, initial]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { return; }
    onSubmit(name.trim(), color);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>
            {initial ? "Edit Workspace" : "New Workspace"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {initial ? "Update your workspace name and color." : "Create a new workspace to organize your collections and tags."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-1">
          <Field>
            <FieldLabel htmlFor="workspace-name">Name</FieldLabel>
            <Input
              id="workspace-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Workspace"
              autoFocus
            />
          </Field>
          <Field>
            <FieldLabel>Color</FieldLabel>
            <div className="flex gap-2 flex-wrap">
              {WORKSPACE_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={cn(
                    "size-7 rounded-full bg-linear-to-br transition-all",
                    WORKSPACE_GRADIENTS[c],
                    color === c
                      ? "ring-2 ring-primary ring-offset-2"
                      : "opacity-50 hover:opacity-100"
                  )}
                />
              ))}
            </div>
          </Field>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!name.trim()}>
              {initial ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// WorkspaceRail
// ---------------------------------------------------------------------------

export function WorkspaceRail() {
  const workspaces = useWorkspaceStore(s => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore(s => s.activeWorkspaceId);
  const setActiveWorkspaceId = useWorkspaceStore(s => s.setActiveWorkspaceId);
  const createWorkspace = useWorkspaceStore(s => s.createWorkspace);
  const updateWorkspace = useWorkspaceStore(s => s.updateWorkspace);
  const deleteWorkspace = useWorkspaceStore(s => s.deleteWorkspace);

  const [createOpen, setCreateOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [editWorkspace, setEditWorkspace] = React.useState<Workspace | null>(
    null
  );

  const sorted = React.useMemo(
    () => [...workspaces].sort((a, b) => a.position - b.position),
    [workspaces]
  );

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col items-center gap-1.5 w-13 shrink-0 h-svh py-3 bg-sidebar border-r border-sidebar-border">
        {/* Logo */}
        <div className="mb-2">
          <div className="size-8 rounded-lg bg-primary/10 flex items-center justify-center">
            <Layers className="size-4 text-primary" />
          </div>
        </div>

        {/* Workspace list */}
        <div className="flex flex-col items-center gap-1.5 flex-1">
          {sorted.map((ws) => {
            const gradient =
              WORKSPACE_GRADIENTS[ws.color as WorkspaceColor] ??
              "from-gray-400 to-gray-500";
            return (
              <div key={ws.id} className="relative group/ws">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setActiveWorkspaceId(ws.id)}
                      className={cn(
                        "size-8 rounded-lg bg-linear-to-br flex items-center justify-center text-[11px] font-semibold text-white shadow-sm ring-offset-sidebar transition-all",
                        gradient,
                        activeWorkspaceId === ws.id
                          ? "ring-2 ring-primary ring-offset-2"
                          : "opacity-60 hover:opacity-100"
                      )}
                    >
                      {getInitials(ws.name)}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">{ws.name}</TooltipContent>
                </Tooltip>

                {/* Context menu */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="absolute -top-1 -right-1 size-4 rounded-full bg-background border border-border opacity-0 group-hover/ws:opacity-100 transition-opacity flex items-center justify-center z-10">
                      <MoreHorizontal className="size-2.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="right" align="start" className="w-36">
                    <DropdownMenuItem
                      onClick={() => setEditWorkspace(ws)}
                    >
                      <Pencil className="size-3.5 mr-2" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => {
                        if (workspaces.length <= 1) { return; }
                        deleteWorkspace(ws.id);
                      }}
                    >
                      <Trash2 className="size-3.5 mr-2" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })}

          {/* Add workspace */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setCreateOpen(true)}
                className="size-8 rounded-lg border-2 border-dashed border-sidebar-border flex items-center justify-center text-muted-foreground hover:border-primary hover:text-primary transition-colors"
              >
                <Plus className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">New Workspace</TooltipContent>
          </Tooltip>
        </div>

        {/* Settings */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button 
              onClick={() => setSettingsOpen(true)}
              className="size-8 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              <Settings className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Settings</TooltipContent>
        </Tooltip>
      </div>

      {/* Dialogs */}
      <WorkspaceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={(name, color) => {
          createWorkspace(name, color);
          setCreateOpen(false);
        }}
      />

      {editWorkspace && (
        <WorkspaceDialog
          open={!!editWorkspace}
          onOpenChange={(open) => {
            if (!open) { setEditWorkspace(null); }
          }}
          initial={editWorkspace}
          onSubmit={(name, color) => {
            updateWorkspace(editWorkspace.id, { name, color });
            setEditWorkspace(null);
          }}
        />
      )}
      
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </TooltipProvider>
  );
}
