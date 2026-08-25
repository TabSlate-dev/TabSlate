import * as React from "react";
import { useGroupsStore } from "@/store/groups-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { isActiveWorkspace } from "@/lib/workspace-visibility";
import { useTranslation } from "@/hooks/use-translation";

const DRAG_TYPE = "application/tabslate-tab";

interface UseGroupDragDropResult {
  isDragOver: boolean;
  notification: string | null;
  dropZoneProps: {
    onDragEnter: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (e: React.DragEvent) => void;
  };
}

export function useGroupDragDrop(groupId: string): UseGroupDragDropResult {
  const { t } = useTranslation();
  const addTabToGroup = useGroupsStore(s => s.addTabToGroup);
  const dragCounter = React.useRef(0);
  const [isDragOver, setIsDragOver] = React.useState(false);
  const [notification, setNotification] = React.useState<string | null>(null);

  const handleDragEnter = React.useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) { return; }
    e.preventDefault();
    dragCounter.current += 1;
    setIsDragOver(true);
  }, []);

  const handleDragOver = React.useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) { return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragLeave = React.useCallback(() => {
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = React.useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCounter.current = 0;
      setIsDragOver(false);

      const raw = e.dataTransfer.getData(DRAG_TYPE);
      if (!raw) { return; }

      try {
        const workspaceState = useWorkspaceStore.getState();
        const groupState = useGroupsStore.getState();
        const activeWorkspace = workspaceState.workspaces.find(
          (workspace) => workspace.id === workspaceState.activeWorkspaceId,
        );
        const targetGroup = groupState.groups.find(
          (group) => group.id === groupId &&
            !group.deletedAt &&
            group.workspaceId === workspaceState.activeWorkspaceId,
        );
        if (!isActiveWorkspace(activeWorkspace) || !targetGroup) {
          setNotification(t("workspaceVisibility_targetUnavailable"));
          return;
        }
        const { title, url, favIconUrl } = JSON.parse(raw) as {
          title: string;
          url: string;
          favIconUrl: string;
        };
        addTabToGroup(groupId, { title, url, favicon: favIconUrl || "" });
        setNotification(null);
      } catch {
        // ignore malformed drag data
      }
    },
    [groupId, addTabToGroup, t]
  );

  return {
    isDragOver,
    notification,
    dropZoneProps: {
      onDragEnter: handleDragEnter,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    },
  };
}
