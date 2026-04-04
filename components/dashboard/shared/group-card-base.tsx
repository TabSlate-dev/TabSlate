import * as React from "react";
import { ChevronDown, ChevronRight, GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import { TAB_GROUP_COLORS, type TabGroupColor } from "@/lib/chrome/tab-groups";

export interface GroupCardBaseProps {
  id: string;
  name: string;
  color: TabGroupColor;
  isCompact?: boolean;
  expanded?: boolean;
  onToggleExpand?: (v: boolean) => void;
  tabCount: number;
  
  // Custom slots for header content
  titleSlot?: React.ReactNode;
  headerActions?: React.ReactNode;
  
  // Drag and drop related (optional)
  isDragging?: boolean;
  isOver?: boolean;
  
  children: React.ReactNode;
  className?: string;
  [key: string]: any; // Allow spreading generic props like D&D handlers
}

export function GroupCardBase({
  id,
  name,
  color,
  isCompact,
  expanded = true,
  onToggleExpand,
  tabCount,
  titleSlot,
  headerActions,
  dragHandleProps,
  dragRef,
  dropRef,
  isDragging,
  isOver,
  children,
  className,
  ...rest // Capture shared props like dropZoneProps
}: GroupCardBaseProps) {
  const groupColor = TAB_GROUP_COLORS[color];

  return (
    <div
      ref={dropRef}
      className={cn(
        "rounded-lg border overflow-hidden transition-colors",
        isDragging && "opacity-50",
        isOver && "border-primary/50 bg-primary/5",
        className
      )}
      style={{ borderLeftColor: groupColor, borderLeftWidth: 3 }}
      {...rest}
    >
      {/* Group header */}
      <div className="flex items-center gap-2 px-3 py-2.5 bg-card">
        {dragRef && (
          <span
            ref={dragRef}
            {...dragHandleProps}
            className="shrink-0 cursor-grab active:cursor-grabbing touch-none text-muted-foreground/30 hover:text-muted-foreground/60 transition-colors"
            title="Drag to save as group"
          >
            <GripVertical className="size-4" />
          </span>
        )}

        <button
          onClick={() => onToggleExpand?.(!expanded)}
          className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
        </button>

        {/* Color dot */}
        <span
          className="inline-block size-3 rounded-full shrink-0"
          style={{ backgroundColor: groupColor }}
        />

        {/* Title Area */}
        <div className="flex-1 min-w-0">
          {titleSlot ? (
            titleSlot
          ) : (
            <span className="text-sm font-semibold truncate block">
              {name || "Unnamed group"}
            </span>
          )}
        </div>

        {/* Right side actions and info */}
        <div className="flex items-center gap-1 shrink-0 ml-auto">
          <span className="text-xs text-muted-foreground mr-2 shrink-0">
            {tabCount} tab{tabCount !== 1 ? "s" : ""}
          </span>
          {headerActions}
        </div>
      </div>

      {/* Children (Tabs) */}
      {expanded && (
        <div className="px-2 pb-2 pt-1 bg-card/50 space-y-0.5">
          {children}
        </div>
      )}
    </div>
  );
}
