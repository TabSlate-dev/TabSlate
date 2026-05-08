import * as React from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSettingsStore, SearchEngine } from "@/store/settings-store";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { GripVertical, Trash2 } from "lucide-react";
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
    if (active.id !== over.id) {
      const oldIndex = searchEngines.findIndex((e) => e.id === active.id);
      const newIndex = searchEngines.findIndex((e) => e.id === over.id);
      updateSearchEngines(arrayMove(searchEngines, oldIndex, newIndex));
    }
  };

  const handleToggle = (id: string, enabled: boolean) => {
    updateSearchEngines(
      searchEngines.map((e) => (e.id === id ? { ...e, enabled } : e))
    );
  };

  const handleDelete = (id: string) => {
    updateSearchEngines(searchEngines.filter((e) => e.id !== id));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription className="sr-only">Configure TabSlate settings</DialogDescription>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto pr-2 -mr-2">
          <div className="space-y-4">
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
            </div>
          </div>
        </div>
        <div className="pt-4 border-t mt-auto flex justify-end">
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
