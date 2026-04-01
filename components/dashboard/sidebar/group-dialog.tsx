import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { FolderPlus } from "lucide-react";
import { ColorPicker } from "@/components/ui/color-picker";
import { useTabsStore } from "@/store/tabs-store";
import { TAB_GROUP_COLOR_KEYS, type TabGroupColor } from "@/lib/chrome/tab-groups";
import { TabRow } from "@/components/dashboard/tab-row";
import type { BrowserTab } from "@/lib/chrome/tabs";

interface GroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (name: string, color: TabGroupColor, selectedTabs: BrowserTab[], compact: boolean) => void;
}

export function GroupDialog({ open, onOpenChange, onSubmit }: GroupDialogProps) {
  const openTabs = useTabsStore(s => s.openTabs);
  const loadTabs = useTabsStore(s => s.loadTabs);

  const [color, setColor] = React.useState<TabGroupColor>("blue");
  const [selectedTabIds, setSelectedTabIds] = React.useState<Set<number>>(new Set());
  const [isCompact, setIsCompact] = React.useState(true);

  React.useEffect(() => {
    if (open) {
      const randomColor = TAB_GROUP_COLOR_KEYS[Math.floor(Math.random() * TAB_GROUP_COLOR_KEYS.length)];
      setColor(randomColor);
      setSelectedTabIds(new Set());
      setIsCompact(true);
      loadTabs();
    }
  }, [open, loadTabs]);

  const toggleTab = React.useCallback((id: number, checked: boolean) => {
    setSelectedTabIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const allSelected = selectedTabIds.size === openTabs.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl max-h-[85vh] flex flex-col p-0 overflow-hidden gap-0 border-none shadow-2xl">
        <form
          className="flex flex-col h-full max-h-[85vh]"
          action={(formData) => {
            if (selectedTabIds.size === 0) return;
            const name = formData.get("name") as string;
            const selectedTabs = openTabs.filter((t) => selectedTabIds.has(t.id));
            onSubmit(name?.trim() || "", color, selectedTabs, isCompact);
            onOpenChange(false);
          }}
        >
          <DialogHeader className="p-4 border-b shrink-0 bg-background/50 backdrop-blur-md">
            <DialogTitle className="flex items-center gap-2 text-xl font-bold">
              <FolderPlus className="size-5 text-primary" />
              New Saved Group
            </DialogTitle>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto p-4 space-y-6">
            <div className="space-y-4">
              <label className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                Group Details
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 bg-muted/20 p-4 rounded-2xl border border-border/50">
                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground ml-1">
                    Group Name
                  </label>
                  <Input
                    name="name"
                    defaultValue=""
                    placeholder="e.g. Work, Social..."
                    className="h-9 focus-visible:ring-primary shadow-sm"
                    autoFocus
                  />
                </div>

                <div className="space-y-4">
                  <label className="text-xs font-medium text-muted-foreground ml-1">
                    Theme Color
                  </label>
                  <ColorPicker value={color} onChange={setColor} />
                </div>
              </div>

              <div className="flex justify-end pt-2">
                <div className="flex items-center gap-2 bg-muted/40 px-3 py-1.5 rounded-full border border-border/50">
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">
                    Compact Name
                  </span>
                  <Switch checked={isCompact} onCheckedChange={setIsCompact} className="scale-90" />
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between border-b pb-2">
                <label className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-3">
                  Select Tabs to Save
                  <span className="text-xs font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                    {selectedTabIds.size} / {openTabs.length}
                  </span>
                </label>
                {openTabs.length > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedTabIds(allSelected ? new Set() : new Set(openTabs.map((t) => t.id)))
                    }
                    className="text-xs font-semibold text-primary hover:text-primary/80 transition-all hover:underline"
                  >
                    {allSelected ? "Deselect All" : "Select All"}
                  </button>
                )}
              </div>

              {openTabs.length === 0 ? (
                <div className="py-20 text-center border-2 border-dashed rounded-2xl bg-muted/5">
                  <p className="text-sm text-muted-foreground">No open tabs found in current window.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pb-4">
                  {openTabs.map((tab) => (
                    <TabRow
                      key={tab.id}
                      tab={tab}
                      showCheckbox
                      selected={selectedTabIds.has(tab.id)}
                      onSelect={(checked) => toggleTab(tab.id, checked)}
                      hideActions
                      variant="card"
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          <DialogFooter className="p-4 border-t bg-muted/30 shrink-0 backdrop-blur-sm">
            <div className="flex items-center gap-3 w-full sm:justify-end">
              <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={selectedTabIds.size === 0}
                className="shadow-sm shadow-primary/10 transition-all hover:translate-y-[-1px] active:translate-y-[0px]"
              >
                Save Group
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
