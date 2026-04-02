import { useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useTabsStore } from "@/store/tabs-store";
import { TAB_GROUP_COLORS } from "@/lib/chrome/tab-groups";

interface JoinGroupDialogProps {
  tabIds: number[];
  isOpen: boolean;
  onClose: () => void;
}

export function JoinGroupDialog({ tabIds, isOpen, onClose }: JoinGroupDialogProps) {
  // Fine-grained selectors
  const tabGroups = useTabsStore(s => s.tabGroups);
  const fullTitles = useTabsStore(s => s.fullTitles);
  const moveTabsToGroup = useTabsStore(s => s.moveTabsToGroup);

  const handleJoin = useCallback(async (groupId: number) => {
    await moveTabsToGroup(tabIds, groupId);
    onClose();
  }, [moveTabsToGroup, tabIds, onClose]);

  if (!tabIds.length) { return null; }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Join Tab Group</DialogTitle>
          <DialogDescription>
            Select an existing group to move the selected tab(s) into.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 py-4 max-h-[300px] overflow-y-auto pr-1">
          {tabGroups.map((group) => {
            const color = TAB_GROUP_COLORS[group.color];
            return (
              <button
                key={group.id}
                onClick={() => handleJoin(group.id)}
                className="flex items-center gap-3 w-full p-2.5 rounded-lg border hover:bg-accent transition-colors text-left"
              >
                <div className="size-3 rounded-full shrink-0" style={{ backgroundColor: color }} />
                <span className="text-sm font-medium truncate">
                  {(fullTitles && fullTitles[group.id]) || group.title || "Unnamed Group"}
                </span>
              </button>
            );
          })}
          {tabGroups.length === 0 && (
            <p className="text-sm text-center text-muted-foreground py-4">
              No active groups found.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
