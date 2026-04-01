import * as React from "react";
import { useDroppable } from "@dnd-kit/core";
import { Pencil, Check, X, Play, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { FaviconImage } from "@/components/ui/favicon-image";
import { ColorPicker } from "@/components/ui/color-picker";
import { useGroupsStore, type SavedGroup, type GroupTab } from "@/store/groups-store";
import { TAB_GROUP_COLORS, type TabGroupColor } from "@/lib/chrome/tab-groups";

interface DroppableGroupCardProps {
  group: SavedGroup;
  tabs: GroupTab[];
}

export function DroppableGroupCard({ group, tabs }: DroppableGroupCardProps) {
  const { isOver, setNodeRef } = useDroppable({
    id: `group-${group.id}`,
    data: { type: "saved-group", groupId: group.id },
  });

  const updateGroup = useGroupsStore(s => s.updateGroup);
  const deleteGroup = useGroupsStore(s => s.deleteGroup);
  const removeTabFromGroup = useGroupsStore(s => s.removeTabFromGroup);
  const openGroup = useGroupsStore(s => s.openGroup);

  const [editing, setEditing] = React.useState(false);
  const [nameVal, setNameVal] = React.useState(group.name);
  const [colorVal, setColorVal] = React.useState<TabGroupColor>(group.color);

  const saveEdit = React.useCallback(() => {
    updateGroup(group.id, { name: nameVal, color: colorVal });
    setEditing(false);
  }, [updateGroup, group.id, nameVal, colorVal]);

  const cancelEdit = React.useCallback(() => {
    setNameVal(group.name);
    setColorVal(group.color);
    setEditing(false);
  }, [group.name, group.color]);

  const handleOpenGroup = React.useCallback(() => openGroup(group.id), [openGroup, group.id]);
  const handleDeleteGroup = React.useCallback(() => deleteGroup(group.id), [deleteGroup, group.id]);

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
            <ColorPicker value={colorVal} onChange={setColorVal} size="sm" />
          </div>
        ) : (
          <span className="flex-1 text-sm font-medium truncate">
            {group.name}
          </span>
        )}
        <div className="flex items-center gap-1 shrink-0">
          {editing ? (
            <>
              <button onClick={saveEdit} className="text-muted-foreground hover:text-foreground">
                <Check className="size-3.5" />
              </button>
              <button onClick={cancelEdit} className="text-muted-foreground hover:text-foreground">
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
                onClick={handleOpenGroup}
                className="text-muted-foreground hover:text-green-500"
                title="Open all tabs"
              >
                <Play className="size-3.5" />
              </button>
              <button
                onClick={handleDeleteGroup}
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
              <FaviconImage src={t.favicon} className="size-4 shrink-0 rounded-sm" />
              <div className="flex-1 min-w-0">
                <p className="text-sm truncate leading-tight">{t.title}</p>
                <p className="text-[11px] text-muted-foreground truncate">{t.url}</p>
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
