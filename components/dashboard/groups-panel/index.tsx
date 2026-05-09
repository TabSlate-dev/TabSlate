import * as React from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { Globe } from "lucide-react";
import { useTabsStore } from "@/store/tabs-store";
import { useGroupsStore } from "@/store/groups-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import type { BrowserTab } from "@/lib/chrome/tabs";
import { DraggableTabRow, TabRowPreview } from "./draggable-tab-row";
import { DroppableGroupCard } from "./droppable-group-card";
import { CreateGroupBar } from "./create-group-bar";

export function GroupsPanel() {
  const openTabs = useTabsStore(s => s.openTabs);
  const loadTabs = useTabsStore(s => s.loadTabs);
  const groups = useGroupsStore(s => s.groups);
  const groupTabs = useGroupsStore(s => s.groupTabs);
  const activeWorkspaceId = useWorkspaceStore(s => s.activeWorkspaceId);

  const activeGroups = React.useMemo(
    () => groups.filter(g => !g.deletedAt && g.workspaceId === activeWorkspaceId),
    [groups, activeWorkspaceId]
  );
  const addTabToGroup = useGroupsStore(s => s.addTabToGroup);
  const moveTab = useGroupsStore(s => s.moveTab);

  const [activeTab, setActiveTab] = React.useState<BrowserTab | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  React.useEffect(() => {
    loadTabs();
  }, [loadTabs]);

  const handleDragStart = React.useCallback((event: DragStartEvent) => {
    const data = event.active.data.current;
    if (data?.type === "browser-tab") { setActiveTab(data.tab); }
  }, []);

  const handleDragEnd = React.useCallback((event: DragEndEvent) => {
    setActiveTab(null);
    const { active, over } = event;
    if (!over) { return; }

    const activeData = active.data.current;
    const overData = over.data.current;

    if (!overData || overData.type !== "saved-group") { return; }
    const targetGroupId: string = overData.groupId;

    if (activeData?.type === "browser-tab") {
      const tab: BrowserTab = activeData.tab;
      addTabToGroup(targetGroupId, {
        title: tab.title,
        url: tab.url,
        favicon: tab.favIconUrl,
      });
    } else if (activeData?.type === "group-tab") {
      moveTab(activeData.tabId, targetGroupId);
    }
  }, [addTabToGroup, moveTab]);

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex flex-1 overflow-hidden h-full">
        {/* Left: open browser tabs */}
        <div className="w-72 shrink-0 border-r flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b">
            <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              Open Tabs ({openTabs.length})
            </p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Drag tabs into a group →
            </p>
          </div>
          <div className="flex-1 overflow-y-auto py-2 space-y-0.5 px-1">
            {openTabs.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-8">
                No open tabs
              </p>
            )}
            {openTabs.map((tab) => (
              <DraggableTabRow key={tab.id} tab={tab} />
            ))}
          </div>
        </div>

        {/* Right: saved groups */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <CreateGroupBar />
          {activeGroups.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
              <Globe className="size-10 mb-3 opacity-30" />
              <p className="text-sm">No groups yet</p>
              <p className="text-xs mt-1">Create a group and drag tabs into it</p>
            </div>
          )}
          {activeGroups.map((group) => (
            <DroppableGroupCard
              key={group.id}
              group={group}
              tabs={groupTabs.filter((t) => t.groupId === group.id)}
            />
          ))}
        </div>
      </div>

      <DragOverlay>
        {activeTab && <TabRowPreview tab={activeTab} />}
      </DragOverlay>
    </DndContext>
  );
}
