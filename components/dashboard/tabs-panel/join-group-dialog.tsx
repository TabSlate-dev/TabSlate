import { useCallback, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useTabsStore } from "@/store/tabs-store";
import { useGroupsStore } from "@/store/groups-store";
import { TAB_GROUP_COLORS } from "@/lib/chrome/tab-groups";
import { Bookmark, Monitor } from "lucide-react";

interface JoinGroupDialogProps {
  tabIds: number[];
  isOpen: boolean;
  onClose: () => void;
}

export function JoinGroupDialog({
  tabIds,
  isOpen,
  onClose,
}: JoinGroupDialogProps) {
  const tabGroups = useTabsStore((s) => s.tabGroups);
  const fullTitles = useTabsStore((s) => s.fullTitles);
  const moveTabsToGroup = useTabsStore((s) => s.moveTabsToGroup);

  const savedGroups = useGroupsStore((s) => s.groups);
  const addTabToGroup = useGroupsStore((s) => s.addTabToGroup);

  const mergedGroups = useMemo(() => {
    const list: Array<{
      id: string;
      chromeId?: number;
      savedId?: string;
      name: string;
      color: string;
    }> = [];

    // Add all Chrome tab groups
    for (const cg of tabGroups) {
      const name =
        (fullTitles && fullTitles[cg.id]) || cg.title || "Unnamed Group";
      list.push({
        id: `chrome-${cg.id}`,
        chromeId: cg.id,
        name,
        color: cg.color,
      });
    }

    // Add Saved Groups
    for (const sg of savedGroups) {
      const existing = list.find((g) => g.name === sg.name);
      if (existing) {
        existing.savedId = sg.id;
      } else {
        list.push({
          id: `saved-${sg.id}`,
          savedId: sg.id,
          name: sg.name,
          color: sg.color,
        });
      }
    }

    return list;
  }, [tabGroups, fullTitles, savedGroups]);

  const handleJoin = useCallback(
    async (chromeId?: number, savedId?: string) => {
      if (chromeId !== undefined) {
        await moveTabsToGroup(tabIds, chromeId);
      }
      if (savedId !== undefined) {
        const openTabs = useTabsStore.getState().openTabs;
        const tabsToMove = openTabs.filter((t) => tabIds.includes(t.id));
        for (const t of tabsToMove) {
          addTabToGroup(savedId, {
            title: t.title,
            url: t.url,
            favicon: t.favIconUrl || "",
          });
        }
      }
      onClose();
    },
    [moveTabsToGroup, addTabToGroup, tabIds, onClose],
  );

  if (!tabIds.length) {
    return null;
  }

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
          {mergedGroups.map((group) => {
            const color =
              TAB_GROUP_COLORS[group.color as keyof typeof TAB_GROUP_COLORS] ||
              TAB_GROUP_COLORS.grey;
            return (
              <button
                key={group.id}
                onClick={() => handleJoin(group.chromeId, group.savedId)}
                className="flex items-center justify-between w-full p-2.5 rounded-lg border hover:bg-accent transition-colors text-left"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className="size-3 rounded-full shrink-0"
                    style={{ backgroundColor: color }}
                  />
                  <span className="text-sm font-medium truncate">
                    {group.name}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0 opacity-50">
                  {group.chromeId !== undefined && (
                    <span title="Open in browser">
                      <Monitor className="size-3" />
                    </span>
                  )}
                  {group.savedId !== undefined && (
                    <span title="Saved group">
                      <Bookmark className="size-3" />
                    </span>
                  )}
                </div>
              </button>
            );
          })}
          {mergedGroups.length === 0 && (
            <p className="text-sm text-center text-muted-foreground py-4">
              No existing groups found.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
