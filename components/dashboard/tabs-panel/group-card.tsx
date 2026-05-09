import React, { useState, useRef, useCallback } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { useTabsStore } from "@/store/tabs-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { useGroupsStore } from "@/store/groups-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ChevronDown,
  ChevronRight,
  Layers,
  MoreHorizontal,
  Ungroup,
  Save,
  X,
  BrushCleaning,
  GripVertical,
  Loader2,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { TAB_GROUP_COLORS } from "@/lib/chrome/tab-groups";
import { ColorPicker } from "@/components/ui/color-picker";
import { TabRow } from "@/components/dashboard/tab-row";
import { DraggableTab } from "./draggable-tab";
import { SaveCollectionDialog } from "./save-collection-dialog";
import { useTabsDndContext, type TabGroupDragData } from "@/components/dashboard/tabs-dnd-provider";
import type { BrowserTabGroup } from "@/lib/chrome/tab-groups";
import type { BrowserTab } from "@/lib/chrome/tabs";

// Small inline dot used for group color indicator
function GroupDot({ color }: { color: BrowserTabGroup["color"] }) {
  return (
    <span
      className="inline-block size-3 rounded-full shrink-0"
      style={{ backgroundColor: TAB_GROUP_COLORS[color] }}
    />
  );
}

interface GroupCardProps {
  group: BrowserTabGroup;
  tabs: BrowserTab[];
  onJoinRequest: (tabIds: number[]) => void;
}

import { GroupCardBase } from "@/components/dashboard/shared/group-card-base";

export function GroupCard({ group, tabs, onJoinRequest }: GroupCardProps) {
  // Fine-grained selectors
  const updateGroup = useTabsStore(s => s.updateGroup);
  const dissolveGroup = useTabsStore(s => s.dissolveGroup);
  const saveGroupAsCollection = useTabsStore(s => s.saveGroupAsCollection);
  const toggleGroupCompact = useTabsStore(s => s.toggleGroupCompact);
  const fullTitles = useTabsStore(s => s.fullTitles);
  const ungroupSpecificTabs = useTabsStore(s => s.ungroupSpecificTabs);
  const closeSpecificTabs = useTabsStore(s => s.closeSpecificTabs);
  const closeGroup = useTabsStore(s => s.closeGroup);
  const compactGroupTitles = useWorkspaceStore(s => s.compactGroupTitles);

  const [expanded, setExpanded] = useState(true);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ saved: number; skipped: number } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const nameRef = useRef<HTMLInputElement>(null);

  const displayTitle = (fullTitles && fullTitles[group.id]) || group.title;

  const {
    attributes: dragAttrs,
    listeners: dragListeners,
    setNodeRef: setDragRef,
    isDragging: isGroupDragging,
  } = useDraggable({
    id: `tab-group-${group.id}`,
    data: {
      type: "tab-group",
      groupId: group.id,
      groupName: displayTitle,
      groupColor: group.color,
      tabs,
    } as TabGroupDragData,
  });

  const { setNodeRef: setDropRef, isOver: isTabOver } = useDroppable({
    id: `group-drop-${group.id}`,
  });

  const { activeData } = useTabsDndContext();
  const showDropIndicator = isTabOver && activeData?.type === "tab";

  const toggleSelect = useCallback((tabId: number, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      checked ? next.add(tabId) : next.delete(tabId);
      return next;
    });
  }, []);

  const handleUngroupSelected = useCallback(async () => {
    await ungroupSpecificTabs(Array.from(selected));
    setSelected(new Set());
  }, [ungroupSpecificTabs, selected]);

  const handleCloseSelected = useCallback(() => {
    closeSpecificTabs(Array.from(selected));
    setSelected(new Set());
  }, [closeSpecificTabs, selected]);

  const handleNameCommit = useCallback(() => {
    if (nameInput.trim() !== group.title) {
      updateGroup(group.id, { title: nameInput.trim() });
    }
    setEditingName(false);
  }, [nameInput, group.title, group.id, updateGroup]);

  const handleSaveGroup = useCallback(async (name: string, deduplicate: boolean) => {
    setIsSaving(true);
    const result = await saveGroupAsCollection(group.id, name, deduplicate);
    setIsSaving(false);
    setSaveDialogOpen(false);
    setSaveResult(result);
    setTimeout(() => setSaveResult(null), 3000);
  }, [saveGroupAsCollection, group.id]);

  const handleSaveAsGroup = useCallback(() => {
    const { createGroup, addTabToGroup } = useGroupsStore.getState();
    const { activeWorkspaceId } = useWorkspaceStore.getState();
    const savedGroupId = createGroup(displayTitle || "Unnamed", group.color, group.title.length === 1, activeWorkspaceId);
    for (const tab of tabs) {
      addTabToGroup(savedGroupId, { title: tab.title || "", url: tab.url, favicon: tab.favIconUrl || "" });
    }
    setSaveResult({ saved: tabs.length, skipped: 0 });
    setTimeout(() => setSaveResult(null), 3000);
  }, [displayTitle, group.color, group.title, tabs]);

  const groupColor = TAB_GROUP_COLORS[group.color];

  // Header components
  const titleSlot = (
    <div className="flex items-center gap-2 min-w-0">
      {editingName ? (
        <Input
          ref={nameRef}
          value={nameInput}
          onChange={(e) => setNameInput(e.target.value)}
          onBlur={handleNameCommit}
          onKeyDown={(e) => {
            if (e.key === "Enter") { handleNameCommit(); }
            if (e.key === "Escape") {
              setNameInput(displayTitle);
              setEditingName(false);
            }
          }}
          className="h-7 text-sm py-0 w-32"
          autoFocus
        />
      ) : (
        <button
          onClick={() => {
            setEditingName(true);
            setNameInput(displayTitle);
          }}
          className="text-sm font-semibold hover:text-primary transition-colors truncate max-w-[150px]"
          title="Click to rename"
        >
          {displayTitle || "Unnamed group"}
        </button>
      )}
      <div className="flex items-center gap-0.5 shrink-0">
        <Button
          variant="ghost"
          size="icon-xs"
          className="size-6 text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
          onClick={handleSaveAsGroup}
          title="Save as Group"
        >
          <Save className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="size-6 text-destructive hover:text-destructive hover:bg-destructive/10 transition-colors"
          onClick={() => dissolveGroup(group.id)}
          title="Ungroup Tabs"
        >
          <Ungroup className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="size-6 text-destructive hover:text-destructive hover:bg-destructive/10 transition-colors"
          onClick={() => closeGroup(group.id)}
          title="Close Group"
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  );

  const headerActions = (
    <div className="flex items-center gap-1">
      {saveResult && (
        <span className="text-[10px] bg-green-500/10 text-green-600 px-1.5 py-0.5 rounded-full animate-in fade-in zoom-in duration-300">
          Saved {saveResult.saved} {saveResult.skipped > 0 && `(${saveResult.skipped} skipped)`}
        </span>
      )}

      {selected.size > 0 && (
        <>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleUngroupSelected}
            className="size-6 text-destructive hover:bg-destructive/10 transition-colors"
            title={`Ungroup ${selected.size} selected tabs`}
          >
            <Ungroup className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleCloseSelected}
            className="size-6 text-destructive hover:bg-destructive/10 transition-colors"
            title={`Close ${selected.size} selected tabs`}
          >
            <X className="size-3.5" />
          </Button>
        </>
      )}

      {/* Color picker */}
      <ColorPicker
        value={group.color}
        onChange={(c) => updateGroup(group.id, { color: c })}
        size="sm"
      />

      {/* Compact Toggle */}
      <div className="flex items-center gap-1.5 px-2 border-l border-r border-border/50">
        <Switch
          checked={group.title.length === 1}
          onCheckedChange={() => toggleGroupCompact(group.id)}
          className="scale-75"
          title="Toggle Compact"
        />
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-tight">
          Compact
        </span>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" className="size-6">
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={handleSaveAsGroup}>
            <Layers className="size-4 mr-2" />
            Save as Group
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setSaveDialogOpen(true)}>
            <Save className="size-4 mr-2" />
            Save as Collection
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive focus:bg-destructive/10 font-medium cursor-pointer"
            onClick={() => dissolveGroup(group.id)}
          >
            <Ungroup className="size-4 mr-2" />
            Ungroup Tabs
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:text-destructive focus:bg-destructive/10 font-medium cursor-pointer"
            onClick={() => closeGroup(group.id)}
          >
            <Trash2 className="size-4 mr-2" />
            Delete Group
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  return (
    <GroupCardBase
      id={String(group.id)}
      name={displayTitle}
      color={group.color}
      expanded={expanded}
      onToggleExpand={setExpanded}
      tabCount={tabs.length}
      titleSlot={titleSlot}
      headerActions={headerActions}
      dragRef={setDragRef}
      dragHandleProps={{ ...dragAttrs, ...dragListeners }}
      dropRef={setDropRef}
      isDragging={isGroupDragging}
      isOver={isTabOver}
    >
      {showDropIndicator && (
        <div className="h-0.5 rounded-full bg-primary/60 mx-1 mb-1" />
      )}
      {tabs.map((tab) => (
        <DraggableTab key={tab.id} tab={tab}>
          <TabRow
            tab={tab}
            showCheckbox
            selected={selected.has(tab.id)}
            onSelect={(checked) => toggleSelect(tab.id, checked)}
            onUngroup={() => ungroupSpecificTabs([tab.id])}
            onJoinGroup={() => onJoinRequest([tab.id])}
          />
        </DraggableTab>
      ))}

      <SaveCollectionDialog
        open={saveDialogOpen}
        defaultName={group.title}
        tabCount={tabs.length}
        isSaving={isSaving}
        onConfirm={handleSaveGroup}
        onClose={() => setSaveDialogOpen(false)}
      />
    </GroupCardBase>
  );
}
