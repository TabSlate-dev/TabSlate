import { useDraggable } from "@dnd-kit/core";
import { GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import type { BrowserTab } from "@/lib/chrome/tabs";
import type { TabDragData } from "@/components/dashboard/tabs-dnd-provider";

interface DraggableTabProps {
  tab: BrowserTab;
  children: React.ReactNode;
}

export function DraggableTab({ tab, children }: DraggableTabProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `tab-${tab.id}`,
    data: {
      type: "tab",
      tabId: tab.id,
      fromGroupId: tab.groupId,
      title: tab.title,
      url: tab.url,
      favIconUrl: tab.favIconUrl,
    } as TabDragData,
  });
  return (
    <div 
      ref={setNodeRef} 
      {...attributes}
      {...listeners}
      className={cn("group/draggable flex items-center cursor-grab active:cursor-grabbing touch-none", isDragging && "opacity-40")}
    >
      <div 
        data-drag-handle
        className="w-5 flex items-center justify-center shrink-0 text-muted-foreground/30 group-hover/draggable:text-muted-foreground/60 transition-colors"
      >
        <GripVertical className="size-3" />
      </div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
