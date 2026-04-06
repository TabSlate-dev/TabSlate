import * as React from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Check, ExternalLink, Layers, Pencil, Play, Trash2, X, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ColorPicker } from "@/components/ui/color-picker";
import { useGroupsStore, type GroupTab, type SavedGroup } from "@/store/groups-store";
import { TAB_GROUP_COLORS, type TabGroupColor } from "@/lib/chrome/tab-groups";
import { useGroupDragDrop } from "@/hooks/use-group-drag-drop";
import { GroupCardBase } from "@/components/dashboard/shared/group-card-base";
import { BaseTabRow } from "@/components/dashboard/shared/base-tab-row";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function GroupDetail() {
  const { groupId } = useParams<{ groupId: string }>();
  const navigate = useNavigate();

  const group = useGroupsStore(s => s.groups.find(g => g.id === groupId));
  const updateGroup = useGroupsStore(s => s.updateGroup);
  const deleteGroup = useGroupsStore(s => s.deleteGroup);
  const openGroup = useGroupsStore(s => s.openGroup);
  const allGroupTabs = useGroupsStore(s => s.groupTabs);
  const removeTabFromGroup = useGroupsStore(s => s.removeTabFromGroup);

  const groupTabs = React.useMemo(
    () =>
      allGroupTabs
        .filter(t => t.groupId === groupId)
        .sort((a, b) => a.position - b.position),
    [allGroupTabs, groupId]
  );

  const [expanded, setExpanded] = React.useState(true);
  const [editing, setEditing] = React.useState(false);
  const [nameVal, setNameVal] = React.useState("");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  // Init local state when group loads
  React.useEffect(() => {
    if (group && !editing) {
      setNameVal(group.name);
    }
  }, [group, editing]);

  const { isDragOver, dropZoneProps } = useGroupDragDrop(groupId ?? "");

  if (!group) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 text-muted-foreground p-10">
        <p className="text-sm">Group not found</p>
        <Button variant="link" onClick={() => navigate("/tabs")} className="mt-2 text-xs">
          Back to Tabs
        </Button>
      </div>
    );
  }

  const handleSaveName = () => {
    if (nameVal.trim() && nameVal.trim() !== group.name) {
      updateGroup(group.id, { name: nameVal.trim() });
    }
    setEditing(false);
  };

  const handleToggleSelect = (tabId: string, checked: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      checked ? next.add(tabId) : next.delete(tabId);
      return next;
    });
  };

  const handleRemoveSelected = () => {
    selected.forEach(id => removeTabFromGroup(id));
    setSelected(new Set());
  };

  const handleDeleteGroup = () => {
    deleteGroup(group.id);
    navigate("/tabs");
  };

  // Header components
  const titleSlot = editing ? (
    <Input
      value={nameVal}
      onChange={(e) => setNameVal(e.target.value)}
      onBlur={handleSaveName}
      className="h-7 text-sm py-0 w-48"
      autoFocus
      onKeyDown={(e) => {
        if (e.key === "Enter") { handleSaveName(); }
        if (e.key === "Escape") {
          setNameVal(group.name);
          setEditing(false);
        }
      }}
    />
  ) : (
    <button
      onClick={() => setEditing(true)}
      className="text-sm font-semibold hover:text-primary transition-colors truncate max-w-[250px]"
    >
      {group.name}
    </button>
  );

  const headerActions = (
    <div className="flex items-center gap-1">
      {selected.size > 0 && (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={handleRemoveSelected}
          className="size-6 text-destructive hover:bg-destructive/10"
          title={`Remove ${selected.size} selected tabs`}
        >
          <X className="size-3.5" />
        </Button>
      )}

      <ColorPicker
        value={group.color}
        onChange={(c) => updateGroup(group.id, { color: c })}
        size="sm"
      />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" className="size-6">
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => openGroup(group.id)}>
            <Play className="size-4 mr-2" />
            Open Group in Chrome
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive focus:bg-destructive/10 font-medium cursor-pointer"
            onClick={handleDeleteGroup}
          >
            <Trash2 className="size-4 mr-2" />
            Delete Group
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  return (
    <div className="flex-1 p-4 md:p-6 overflow-auto">
      <GroupCardBase
        id={group.id}
        name={group.name}
        color={group.color}
        expanded={expanded}
        onToggleExpand={setExpanded}
        tabCount={groupTabs.length}
        titleSlot={titleSlot}
        headerActions={headerActions}
        isOver={isDragOver}
        {...dropZoneProps}
        className="max-w-[95%] mx-auto"
      >
        {isDragOver && (
          <div className="flex items-center justify-center p-4 bg-primary/5 rounded-md border border-dashed border-primary/30 mb-2">
            <Layers className="size-5 text-primary mr-2" />
            <span className="text-sm font-medium text-primary">Drop to add to group</span>
          </div>
        )}

        {groupTabs.length === 0 && !isDragOver && (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground select-none">
            <Layers className="size-10 mb-3 opacity-30" />
            <p className="text-sm">No tabs in this group</p>
            <p className="text-xs mt-1 opacity-70">Drag tabs from your workspace to add them</p>
          </div>
        )}

        {groupTabs.map((tab) => (
          <BaseTabRow
            key={tab.id}
            title={tab.title}
            url={tab.url}
            favicon={tab.favicon}
            selected={selected.has(tab.id)}
            showCheckbox
            onSelect={(checked) => handleToggleSelect(tab.id, checked)}
            actions={
              <div className="flex items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    window.open(tab.url, "_blank");
                  }}
                  title="Open"
                  className="size-6"
                >
                  <ExternalLink className="size-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeTabFromGroup(tab.id);
                  }}
                  title="Remove from group"
                  className="size-6 hover:text-destructive"
                >
                  <X className="size-3" />
                </Button>
              </div>
            }
          />
        ))}
      </GroupCardBase>
    </div>
  );
}
