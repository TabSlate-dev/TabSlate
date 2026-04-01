import { useState, useCallback, useEffect, useRef } from "react";
import { useTabsStore } from "@/store/tabs-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Layers, Plus, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { ColorPicker } from "@/components/ui/color-picker";
import { TabRow } from "@/components/dashboard/tab-row";
import { DraggableTab } from "./draggable-tab";
import type { BrowserTab } from "@/lib/chrome/tabs";
import { TAB_GROUP_COLOR_KEYS, type TabGroupColor } from "@/lib/chrome/tab-groups";

interface UngroupedSectionProps {
  tabs: BrowserTab[];
  onJoinRequest: (tabIds: number[]) => void;
}

export function UngroupedSection({ tabs, onJoinRequest }: UngroupedSectionProps) {
  const createGroup = useTabsStore(s => s.createGroup);
  const ungroupSpecificTabs = useTabsStore(s => s.ungroupSpecificTabs);

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [groupName, setGroupName] = useState("");
  const [groupColor, setGroupColor] = useState<TabGroupColor>("blue");
  const [isCompact, setIsCompact] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const prevSelectedSize = useRef(0);

  useEffect(() => {
    if (selected.size > 0 && prevSelectedSize.current === 0) {
      setGroupColor(TAB_GROUP_COLOR_KEYS[Math.floor(Math.random() * TAB_GROUP_COLOR_KEYS.length)]);
    }
    prevSelectedSize.current = selected.size;
  }, [selected.size]);

  const toggleSelect = useCallback((tabId: number, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      checked ? next.add(tabId) : next.delete(tabId);
      return next;
    });
  }, []);

  const handleCreateGroup = useCallback(async () => {
    if (!selected.size || isCreating) return;
    setIsCreating(true);
    await createGroup(Array.from(selected), groupName.trim(), groupColor, isCompact);
    setSelected(new Set());
    setGroupName("");
    setIsCreating(false);
  }, [selected, isCreating, createGroup, groupName, groupColor, isCompact]);

  if (tabs.length === 0) return null;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between px-1">
        <p className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
          Ungrouped
        </p>
        <span className="text-[10px] font-semibold text-muted-foreground">
          {tabs.length}
        </span>
      </div>

      <div className="rounded-lg border bg-card divide-y divide-border/50">
        {tabs.map((tab) => (
          <DraggableTab key={tab.id} tab={tab}>
            <TabRow
              tab={tab}
              showCheckbox
              selected={selected.has(tab.id)}
              onSelect={(checked) => toggleSelect(tab.id, checked)}
              onJoinGroup={() => onJoinRequest([tab.id])}
              isUngrouped
            />
          </DraggableTab>
        ))}
      </div>

      {selected.size > 0 && (
        <div className="flex items-center gap-2 p-3 rounded-lg border bg-muted/50 mt-2">
          <Layers className="size-4 text-muted-foreground shrink-0" />
          <Input
            placeholder="Group name..."
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreateGroup()}
            className="h-8 text-sm flex-1 md:max-w-xs"
          />
          <div className="flex items-center gap-4 ml-auto">
            <span className="text-xs font-medium text-muted-foreground">
              {selected.size} tab{selected.size !== 1 ? "s" : ""}
            </span>
            <div className="flex items-center gap-2 px-1">
              <Switch
                checked={isCompact}
                onCheckedChange={setIsCompact}
                className="scale-90"
              />
              <span className="text-[10px] font-medium text-muted-foreground whitespace-nowrap hidden sm:inline uppercase tracking-tight">
                Compact
              </span>
            </div>
            <ColorPicker value={groupColor} onChange={setGroupColor} />
            <Button
              size="sm"
              onClick={handleCreateGroup}
              disabled={isCreating}
              className="shadow-sm shadow-primary/20"
            >
              {isCreating ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Plus className="size-4 mr-1.5" />
              )}
              Create
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
