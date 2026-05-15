import * as React from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ImportDialog } from "@/components/dashboard/import-dialog";
import { useSettingsStore, SearchEngine } from "@/store/settings-store";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { GripVertical, Trash2, Plus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

function SortableSearchEngineItem({
  engine,
  onToggle,
  onDelete,
}: {
  engine: SearchEngine;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: engine.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 1 : 0,
  };

  function getEngineIconSrc(engine: { iconUrl?: string; siteUrl: string }): string {
    if (engine.iconUrl && typeof chrome !== "undefined" && chrome.runtime?.id) {
      return chrome.runtime.getURL(engine.iconUrl);
    }
    try {
      const domain = new URL(engine.siteUrl).hostname;
      return `https://icons.duckduckgo.com/ip3/${domain}.ico`;
    } catch {
      return "";
    }
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center justify-between p-3 rounded-lg border bg-card ${isDragging ? 'shadow-md ring-1 ring-primary/20' : ''}`}
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing p-1"
        >
          <GripVertical className="size-4" />
        </button>
        <img src={getEngineIconSrc(engine)} alt={engine.name} className="size-5 rounded-sm" />
        <span className="font-medium text-sm">{engine.name}</span>
      </div>
      <div className="flex items-center gap-2">
        <Switch
          checked={engine.enabled}
          onCheckedChange={(checked) => onToggle(engine.id, checked)}
        />
        {engine.custom && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Delete ${engine.name}`}
            className="size-7 text-muted-foreground hover:text-destructive"
            onClick={() => onDelete(engine.id)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const searchEngines = useSettingsStore(s => s.searchEngines);
  const updateSearchEngines = useSettingsStore(s => s.updateSearchEngines);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event: any) => {
    const { active, over } = event;
    if (!over || active.id === over.id) { return; }
    const oldIndex = searchEngines.findIndex((e) => e.id === active.id);
    const newIndex = searchEngines.findIndex((e) => e.id === over.id);
    updateSearchEngines(arrayMove(searchEngines, oldIndex, newIndex));
  };

  const handleToggle = (id: string, enabled: boolean) => {
    updateSearchEngines(
      searchEngines.map((e) => (e.id === id ? { ...e, enabled } : e))
    );
  };

  const handleDelete = (id: string) => {
    updateSearchEngines(searchEngines.filter((e) => e.id !== id));
  };

  const [importDialogOpen, setImportDialogOpen] = React.useState(false);
  const [showForm, setShowForm] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [newUrl, setNewUrl] = React.useState("");

  React.useEffect(() => {
    if (!open) {
      setShowForm(false);
      setNewName("");
      setNewUrl("");
    }
  }, [open]);

  const canAdd = (() => {
    if (!newName.trim() || !newUrl.trim().includes("%s")) { return false; }
    try {
      new URL(newUrl.trim().replace("%s", "x"));
      return true;
    } catch {
      return false;
    }
  })();

  const [searchOverlayEnabled, setSearchOverlayEnabled] = React.useState(false);

  React.useEffect(() => {
    if (open && typeof chrome !== "undefined" && chrome.permissions) {
      chrome.permissions.contains({ origins: ["<all_urls>"] }).then(setSearchOverlayEnabled);
    }
  }, [open]);

  const handleToggleSearchOverlay = async (checked: boolean) => {
    if (typeof chrome === "undefined" || !chrome.permissions) return;
    
    if (checked) {
      const granted = await chrome.permissions.request({ origins: ["<all_urls>"] });
      setSearchOverlayEnabled(granted);
    } else {
      const removed = await chrome.permissions.remove({ origins: ["<all_urls>"] });
      if (removed) {
        setSearchOverlayEnabled(false);
      }
    }
  };

  const handleAdd = () => {
    const siteUrl = (() => {
      try {
        return new URL(newUrl.trim().replace("%s", "x")).origin;
      } catch {
        return "";
      }
    })();
    const engine: SearchEngine = {
      id: crypto.randomUUID(),
      name: newName.trim(),
      url: newUrl.trim(),
      siteUrl,
      custom: true,
      enabled: true,
    };
    updateSearchEngines([...searchEngines, engine]);
    setNewName("");
    setNewUrl("");
    setShowForm(false);
  };

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription className="sr-only">Configure TabSlate settings</DialogDescription>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto pr-2 -mr-2">
          <div className="space-y-6">
            <div className="rounded-lg border p-3 shadow-sm">
              <div className="flex flex-row items-center justify-between">
                <div className="space-y-0.5">
                  <h3 className="text-sm font-medium">Global Search Overlay</h3>
                  <p className="text-xs text-muted-foreground mr-4">
                    Press <kbd className="px-1 py-0.5 rounded-md bg-muted border font-sans text-[10px]">Ctrl+Shift+K</kbd> to search your tabs and bookmarks on any website.
                  </p>
                </div>
                <Switch
                  checked={searchOverlayEnabled}
                  onCheckedChange={handleToggleSearchOverlay}
                />
              </div>
            </div>

            <div>
              <h3 className="text-sm font-medium mb-1">Search Engines</h3>
              <p className="text-xs text-muted-foreground mb-4">
                Enable or disable search engines and drag to reorder them. The first enabled engine is the default.
              </p>
              
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={searchEngines.map((e) => e.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-2">
                    {searchEngines.map((engine) => (
                      <SortableSearchEngineItem
                        key={engine.id}
                        engine={engine}
                        onToggle={handleToggle}
                        onDelete={handleDelete}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>

              {showForm ? (
                <div className="mt-3 space-y-2 rounded-lg border bg-card p-3">
                  <Input
                    placeholder="Name"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    autoFocus
                  />
                  <Input
                    placeholder="https://example.com/search?q=%s"
                    value={newUrl}
                    onChange={(e) => setNewUrl(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Use <code className="font-mono">%s</code> as the search term placeholder
                  </p>
                  <div className="flex justify-end gap-2 pt-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setShowForm(false);
                        setNewName("");
                        setNewUrl("");
                      }}
                    >
                      Cancel
                    </Button>
                    <Button size="sm" disabled={!canAdd} onClick={handleAdd}>
                      Add
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2 w-full text-muted-foreground hover:text-foreground"
                  onClick={() => setShowForm(true)}
                >
                  <Plus className="size-3.5 mr-1" />
                  Add engine
                </Button>
              )}
            </div>

            <div className="space-y-2 pt-2">
              <h3 className="text-sm font-medium">Data Import</h3>
              <p className="text-xs text-muted-foreground">
                Import your saved tabs from other extensions.
              </p>
              <Button variant="outline" size="sm" onClick={() => setImportDialogOpen(true)}>
                Import Bookmarks
              </Button>
            </div>
          </div>
        </div>
        <div className="pt-4 border-t mt-auto flex justify-end">
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </div>
      </DialogContent>
    </Dialog>
    <ImportDialog open={importDialogOpen} onOpenChange={setImportDialogOpen} />
    </>
  );
}
