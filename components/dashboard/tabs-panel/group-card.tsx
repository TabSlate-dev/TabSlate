import React, { useState, useRef, useCallback } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { useTabsStore } from "@/store/tabs-store";
import { useWorkspaceStore } from "@/store/workspace-store";
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
    setTimeout(() => setSaveResult(null), 3500);
  }, [saveGroupAsCollection, group.id]);

  const groupColor = TAB_GROUP_COLORS[group.color];

  return (
    <div
      ref={setDropRef}
      className={cn(
        "rounded-lg border overflow-hidden transition-colors",
        isGroupDragging && "opacity-50",
        showDropIndicator && "border-primary/50 bg-primary/5"
      )}
      style={{ borderLeftColor: groupColor, borderLeftWidth: 3 }}
    >
      {/* Group header */}
      <div className="flex items-center gap-2 px-3 py-2.5 bg-card">
        <span
          ref={setDragRef}
          {...dragAttrs}
          {...dragListeners}
          className="shrink-0 cursor-grab active:cursor-grabbing touch-none text-muted-foreground/30 hover:text-muted-foreground/60 transition-colors"
          title="Drag to save as group"
        >
          <GripVertical className="size-4" />
        </span>

        <button
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
        </button>

        <GroupDot color={group.color} />

        {editingName ? (
          <Input
            ref={nameRef}
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onBlur={handleNameCommit}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleNameCommit();
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

        {saveResult && (
          <span className="ml-2 text-[10px] bg-green-500/10 text-green-600 px-1.5 py-0.5 rounded-full animate-in fade-in zoom-in duration-300 shrink-0">
            Saved {saveResult.saved} {saveResult.skipped > 0 && `(${saveResult.skipped} skipped)`}
          </span>
        )}

        {selected.size > 0 && (
          <>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={handleUngroupSelected}
              className="size-6 text-destructive hover:bg-destructive/10 transition-colors shrink-0 ml-1"
              title={`Ungroup ${selected.size} selected tab${selected.size !== 1 ? "s" : ""}`}
            >
              <Ungroup className="size-3.5 text-destructive" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={handleCloseSelected}
              className="size-6 text-destructive hover:bg-destructive/10 transition-colors shrink-0 ml-1"
              title={`Close ${selected.size} selected tab${selected.size !== 1 ? "s" : ""}`}
            >
              <X className="size-3.5" />
            </Button>
          </>
        )}

        <div className="flex items-center gap-1 shrink-0 ml-auto">
          <span className="text-xs text-muted-foreground mr-2 shrink-0">
            {tabs.length} tab{tabs.length !== 1 ? "s" : ""}
          </span>
          {/* Color picker */}
          <div className="flex items-center gap-1 shrink-0 px-2">
            <ColorPicker
              value={group.color}
              onChange={(c) => updateGroup(group.id, { color: c })}
              size="sm"
            />
          </div>

          {/* Compact Toggle */}
          <div className="flex items-center gap-1.5 px-2 border-l border-r border-border/50">
            <Switch
              checked={group.title.length === 1}
              onCheckedChange={() => toggleGroupCompact(group.id)}
              className="scale-75"
              title="Toggle Compact Mode for this Group"
            />
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-tight">
              Compact
            </span>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" className="size-6 shrink-0">
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setSaveDialogOpen(true)}>
                <Save className="size-4 mr-2" />
                Save as Collection
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive focus:bg-destructive/10 font-medium cursor-pointer"
                onClick={() => dissolveGroup(group.id)}
              >
                <Ungroup className="size-4 mr-2 text-destructive" />
                Ungroup Tabs
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive focus:text-destructive focus:bg-destructive/10 font-medium cursor-pointer"
                onClick={() => closeGroup(group.id)}
              >
                <Trash2 className="size-4 mr-2 text-destructive" />
                Delete Group
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Tabs */}
      {expanded && (
        <div className="px-2 pb-2 pt-1 bg-card/50 space-y-0.5">
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
        </div>
      )}

      <SaveCollectionDialog
        open={saveDialogOpen}
        defaultName={group.title}
        tabCount={tabs.length}
        isSaving={isSaving}
        onConfirm={handleSaveGroup}
        onClose={() => setSaveDialogOpen(false)}
      />
    </div>
  );
}
