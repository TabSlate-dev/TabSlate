import { useDraggable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import { GripVertical } from "lucide-react";
import { FaviconImage } from "@/components/ui/favicon-image";
import type { BrowserTab } from "@/lib/chrome/tabs";

// ---------------------------------------------------------------------------
// DraggableTabRow — left panel tab that can be dragged into a group
// ---------------------------------------------------------------------------
export function DraggableTabRow({ tab }: { tab: BrowserTab }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `tab-${tab.id}`,
    data: { type: "browser-tab", tab },
  });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={cn(
        "flex items-center gap-2 px-3 py-2 rounded-md hover:bg-muted/60 cursor-grab active:cursor-grabbing touch-none group/draggable",
        isDragging && "opacity-40"
      )}
    >
      <div 
        data-drag-handle
        className="w-5 flex items-center justify-center shrink-0 text-muted-foreground/30 group-hover/draggable:text-muted-foreground/60 transition-colors"
      >
        <GripVertical className="size-3.5" />
      </div>
      <FaviconImage src={tab.favIconUrl} className="size-4 shrink-0 rounded-sm" />
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
export function TabRowPreview({ tab }: { tab: BrowserTab }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-background border shadow-lg w-72">
      <FaviconImage src={tab.favIconUrl} className="size-4 shrink-0 rounded-sm" />
      <p className="text-sm truncate">{tab.title}</p>
    </div>
  );
}
