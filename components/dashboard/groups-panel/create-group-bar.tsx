import * as React from "react";
import { AlertCircle, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ColorPicker } from "@/components/ui/color-picker";
import { useGroupsStore } from "@/store/groups-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import type { TabGroupColor } from "@/lib/chrome/tab-groups";
import { useTranslation } from "@/hooks/use-translation";
import { isActiveWorkspace } from "@/lib/workspace-visibility";
import { Alert, AlertDescription } from "@/components/ui/alert";

export function CreateGroupBar() {
  const { t } = useTranslation();
  const createGroup = useGroupsStore(s => s.createGroup);
  const [name, setName] = React.useState("");
  const [color, setColor] = React.useState<TabGroupColor>("blue");
  const [open, setOpen] = React.useState(false);
  const [targetUnavailable, setTargetUnavailable] = React.useState(false);

  const handleCreate = React.useCallback(() => {
    if (!name.trim()) { return; }
    const state = useWorkspaceStore.getState();
    const activeWorkspace = state.workspaces.find(
      (workspace) => workspace.id === state.activeWorkspaceId,
    );
    if (!isActiveWorkspace(activeWorkspace)) {
      setTargetUnavailable(true);
      return;
    }
    createGroup(name.trim(), color, true, state.activeWorkspaceId);
    setName("");
    setColor("blue");
    setOpen(false);
    setTargetUnavailable(false);
  }, [createGroup, name, color]);

  if (!open) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="w-full"
        onClick={() => setOpen(true)}
      >
        <Plus className="size-4 mr-1" />
        {t("groupsPanel_newGroup")}
      </Button>
    );
  }

  return (
    <div className="border rounded-lg p-3 space-y-2 bg-card">
      {targetUnavailable && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{t("workspaceVisibility_targetUnavailable")}</AlertDescription>
        </Alert>
      )}
      <Input
        autoFocus
        placeholder={t("groupsPanel_groupName")}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { handleCreate(); }
          if (e.key === "Escape") { setOpen(false); }
        }}
        className="h-8 text-sm"
      />
      <ColorPicker value={color} onChange={setColor} size="sm" />
      <div className="flex gap-2">
        <Button size="sm" className="flex-1" onClick={handleCreate}>
          {t("groupsPanel_create")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
          {t("groupsPanel_cancel")}
        </Button>
      </div>
    </div>
  );
}
