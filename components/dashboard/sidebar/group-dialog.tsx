import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Field, FieldLabel } from "@/components/ui/field";
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
      if (checked) { next.add(id); }
      else { next.delete(id); }
      return next;
    });
  }, []);

  const allSelected = selectedTabIds.size === openTabs.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl max-h-[85vh] flex flex-col p-0 overflow-hidden gap-0">
        <form
          className="flex flex-col h-full max-h-[85vh]"
          action={(formData) => {
            if (selectedTabIds.size === 0) { return; }
            const name = formData.get("name") as string;
            const selectedTabs = openTabs.filter((t) => selectedTabIds.has(t.id));
            onSubmit(name?.trim() || "", color, selectedTabs, isCompact);
            onOpenChange(false);
          }}
        >
          <DialogHeader className="p-4 border-b shrink-0 bg-background">
            <DialogTitle className="flex items-center gap-2 text-xl font-bold">
              <FolderPlus className="size-5 text-primary" />
              New Saved Group
            </DialogTitle>
            <DialogDescription className="sr-only">
              Create a new saved tab group with a name, color, and selected tabs.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto p-4 space-y-6">
            <div className="space-y-4">
              <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 w-[70%]">
                <FieldLabel htmlFor="group-name" className="col-span-2">Group Name</FieldLabel>
                <Input
                  id="group-name"
                  name="name"
                  defaultValue=""
                  placeholder="e.g. Work, Social..."
                  autoFocus
                />
                <div className="flex items-center gap-1.5">
                  <Switch id="compact-name" checked={isCompact} onCheckedChange={setIsCompact} />
                  <div className="relative text-xs text-muted-foreground select-none whitespace-nowrap">
                    <span className="invisible" aria-hidden>Show compact name</span>
                    <span className="absolute top-0 left-0">{isCompact ? "Show compact name" : "Show full name"}</span>
                  </div>
                </div>
              </div>

              <Field>
                <FieldLabel>Theme Color</FieldLabel>
                <ColorPicker value={color} onChange={setColor} />
              </Field>
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between border-b pb-2">
                <Label className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-3">
                  Select Tabs to Save
                  <span className="text-xs font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                    {selectedTabIds.size} / {openTabs.length}
                  </span>
                </Label>
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

          <DialogFooter className="p-4 border-t bg-muted/50 shrink-0">
            <div className="flex items-center gap-3 w-full sm:justify-end">
              <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={selectedTabIds.size === 0}
                className="shadow-sm shadow-primary/10 transition-all hover:-translate-y-px active:translate-y-0"
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
