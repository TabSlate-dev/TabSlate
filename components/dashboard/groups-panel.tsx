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
import { useDroppable, useDraggable } from "@dnd-kit/core";
import {
  Plus,
  Play,
  Trash2,
  GripVertical,
  Globe,
  Pencil,
  Check,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTabsStore } from "@/store/tabs-store";
import { useGroupsStore, type SavedGroup } from "@/store/groups-store";
import { TAB_GROUP_COLORS, TAB_GROUP_COLOR_KEYS, type TabGroupColor } from "@/lib/chrome/tab-groups";
import type { BrowserTab } from "@/lib/chrome/tabs";

// ---------------------------------------------------------------------------
// ColorPicker
// ---------------------------------------------------------------------------
function ColorPicker({
  value,
  onChange,
}: {
  value: TabGroupColor;
  onChange: (c: TabGroupColor) => void;
}) {
  return (
    <div className="flex gap-1 flex-wrap">
      {TAB_GROUP_COLOR_KEYS.map((c) => (
        <button
          key={c}
          onClick={() => onChange(c)}
          className={cn(
            "size-4 rounded-full ring-offset-1 transition-all",
            value === c && "ring-2 ring-primary"
          )}
          style={{ backgroundColor: TAB_GROUP_COLORS[c] }}
          title={c}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DraggableTabRow — left panel tab that can be dragged into a group
// ---------------------------------------------------------------------------
function DraggableTabRow({ tab }: { tab: BrowserTab }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `tab-${tab.id}`,
    data: { type: "browser-tab", tab },
  });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      className={cn(
        "flex items-center gap-2 px-3 py-2 rounded-md hover:bg-muted/60 cursor-grab active:cursor-grabbing group",
        isDragging && "opacity-40"
      )}
    >
      <span {...listeners} className="text-muted-foreground/40 hover:text-muted-foreground shrink-0">
        <GripVertical className="size-3.5" />
      </span>
      <img
        src={tab.favIconUrl || ""}
        alt=""
        className="size-4 shrink-0 rounded-sm"
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = "none";
        }}
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm truncate leading-tight">{tab.title}</p>
        <p className="text-[11px] text-muted-foreground truncate">{tab.url}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TabRowPreview — shown in DragOverlay
// ---------------------------------------------------------------------------
function TabRowPreview({ tab }: { tab: BrowserTab }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-background border shadow-lg w-72">
      <img
        src={tab.favIconUrl || ""}
        alt=""
        className="size-4 shrink-0 rounded-sm"
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = "none";
        }}
      />
      <p className="text-sm truncate">{tab.title}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DroppableGroupCard
// ---------------------------------------------------------------------------
function DroppableGroupCard({
  group,
  tabs,
}: {
  group: SavedGroup;
  tabs: import("@/store/groups-store").GroupTab[];
}) {
  const { isOver, setNodeRef } = useDroppable({
    id: `group-${group.id}`,
    data: { type: "saved-group", groupId: group.id },
  });

  const { updateGroup, deleteGroup, removeTabFromGroup, openGroup } =
    useGroupsStore();

  const [editing, setEditing] = React.useState(false);
  const [nameVal, setNameVal] = React.useState(group.name);
  const [colorVal, setColorVal] = React.useState<TabGroupColor>(group.color);

  function saveEdit() {
    updateGroup(group.id, { name: nameVal, color: colorVal });
    setEditing(false);
  }

  function cancelEdit() {
    setNameVal(group.name);
    setColorVal(group.color);
    setEditing(false);
  }

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "rounded-lg border bg-card transition-colors",
        isOver && "border-primary bg-primary/5"
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b">
        <span
          className="size-3 rounded-full shrink-0"
          style={{ backgroundColor: TAB_GROUP_COLORS[group.color] }}
        />
        {editing ? (
          <div className="flex-1 flex flex-col gap-2">
            <Input
              value={nameVal}
              onChange={(e) => setNameVal(e.target.value)}
              className="h-7 text-sm"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") saveEdit();
                if (e.key === "Escape") cancelEdit();
              }}
            />
            <ColorPicker value={colorVal} onChange={setColorVal} />
          </div>
        ) : (
          <span className="flex-1 text-sm font-medium truncate">
            {group.name}
          </span>
        )}
        <div className="flex items-center gap-1 shrink-0">
          {editing ? (
            <>
              <button
                onClick={saveEdit}
                className="text-muted-foreground hover:text-foreground"
              >
                <Check className="size-3.5" />
              </button>
              <button
                onClick={cancelEdit}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setEditing(true)}
                className="text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100"
              >
                <Pencil className="size-3.5" />
              </button>
              <button
                onClick={() => openGroup(group.id)}
                className="text-muted-foreground hover:text-green-500"
                title="Open all tabs"
              >
                <Play className="size-3.5" />
              </button>
              <button
                onClick={() => deleteGroup(group.id)}
                className="text-muted-foreground hover:text-destructive"
                title="Delete group"
              >
                <Trash2 className="size-3.5" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Tab list */}
      <div className="divide-y">
        {tabs.length === 0 && (
          <p className="px-3 py-4 text-xs text-muted-foreground text-center">
            Drop tabs here
          </p>
        )}
        {tabs
          .sort((a, b) => a.position - b.position)
          .map((t) => (
            <div
              key={t.id}
              className="flex items-center gap-2 px-3 py-2 hover:bg-muted/40 group/tab"
            >
              <img
                src={t.favicon || ""}
                alt=""
                className="size-4 shrink-0 rounded-sm"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm truncate leading-tight">{t.title}</p>
                <p className="text-[11px] text-muted-foreground truncate">
                  {t.url}
                </p>
              </div>
              <button
                onClick={() => removeTabFromGroup(t.id)}
                className="opacity-0 group-hover/tab:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CreateGroupBar
// ---------------------------------------------------------------------------
function CreateGroupBar() {
  const { createGroup } = useGroupsStore();
  const [name, setName] = React.useState("");
  const [color, setColor] = React.useState<TabGroupColor>("blue");
  const [open, setOpen] = React.useState(false);

  function handleCreate() {
    if (!name.trim()) return;
    createGroup(name.trim(), color);
    setName("");
    setColor("blue");
    setOpen(false);
  }

  if (!open) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="w-full"
        onClick={() => setOpen(true)}
      >
        <Plus className="size-4 mr-1" />
        New Group
      </Button>
    );
  }

  return (
    <div className="border rounded-lg p-3 space-y-2 bg-card">
      <Input
        autoFocus
        placeholder="Group name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleCreate();
          if (e.key === "Escape") setOpen(false);
        }}
        className="h-8 text-sm"
      />
      <ColorPicker value={color} onChange={setColor} />
      <div className="flex gap-2">
        <Button size="sm" className="flex-1" onClick={handleCreate}>
          Create
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GroupsPanel — main component
// ---------------------------------------------------------------------------
export function GroupsPanel() {
  const { openTabs, loadTabs } = useTabsStore();
  const { groups, groupTabs, addTabToGroup, moveTab } = useGroupsStore();

  const [activeTab, setActiveTab] = React.useState<BrowserTab | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  // Load tabs on mount and listen for changes
  React.useEffect(() => {
    loadTabs();
    const handler = (changes: Record<string, chrome.storage.StorageChange>) => {
      if ("tabmaster-tabs-changed" in changes) loadTabs();
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }, []);

  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current;
    if (data?.type === "browser-tab") setActiveTab(data.tab);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveTab(null);
    const { active, over } = event;
    if (!over) return;

    const activeData = active.data.current;
    const overData = over.data.current;

    if (!overData || overData.type !== "saved-group") return;
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
  }

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
          {groups.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
              <Globe className="size-10 mb-3 opacity-30" />
              <p className="text-sm">No groups yet</p>
              <p className="text-xs mt-1">Create a group and drag tabs into it</p>
            </div>
          )}
          {groups.map((group) => (
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
