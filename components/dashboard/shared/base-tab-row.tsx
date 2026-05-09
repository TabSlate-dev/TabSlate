import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { FaviconImage } from "@/components/ui/favicon-image";

export interface BaseTabRowProps {
  title: string;
  url: string;
  favicon?: string;
  active?: boolean;
  selected?: boolean;
  isHighlighted?: boolean;
  showCheckbox?: boolean;
  onSelect?: (checked: boolean) => void;
  onClick?: (e: React.MouseEvent) => void;
  actions?: React.ReactNode;
  className?: string;
  isUngrouped?: boolean;
}

export const BaseTabRow = React.forwardRef<HTMLDivElement, BaseTabRowProps>(
  (
    {
      title,
      url,
      favicon,
      active,
      selected,
      isHighlighted,
      showCheckbox,
      onSelect,
      onClick,
      actions,
      className,
      isUngrouped,
    },
    ref
  ) => {
    return (
      <div
        ref={ref}
        className={cn(
          "group isolate relative flex items-center gap-2.5 px-3 py-2 transition-all cursor-pointer",
          !isUngrouped && "rounded-md hover:bg-accent/50",
          selected && !isUngrouped && "bg-accent/40",
          active && !selected && !isUngrouped && "bg-blue-50/60 dark:bg-blue-950/20",
          isHighlighted && "ring-2 ring-amber-500 bg-amber-500/10 rounded-md shadow-sm z-10",
          className
        )}
        onClick={onClick}
      >
        {isUngrouped && (
          <div
            className={cn(
              "absolute inset-x-0.5 inset-y-0.5 rounded-md pointer-events-none transition-colors -z-10",
              selected ? "bg-accent/50" : "group-hover:bg-accent/40"
            )}
          />
        )}

        {showCheckbox && (
          <div
            className="shrink-0 flex items-center justify-center p-2 -ml-2 -my-2 mr-0 cursor-pointer"
            onClick={(e) => {
              e.stopPropagation();
              onSelect?.(!selected);
            }}
          >
            <div
              className={cn(
                "flex size-4 items-center justify-center rounded-sm border border-primary transition-all",
                selected ? "bg-primary text-primary-foreground" : "bg-transparent text-transparent"
              )}
            >
              <Check
                className={cn("size-3", selected ? "opacity-100" : "opacity-0")}
                strokeWidth={3}
              />
            </div>
          </div>
        )}

        <div className="size-6 rounded bg-muted flex items-center justify-center shrink-0 overflow-hidden">
          <FaviconImage src={favicon || ""} className="size-4" />
        </div>

        {/* Title & URL */}
        <div className="flex-1 min-w-0">
          <p className={cn("text-sm truncate leading-tight", active && "font-medium")}>
            {title || url}
          </p>
          <p className="text-[11px] text-muted-foreground truncate opacity-70">
            {url}
          </p>
        </div>

        {/* Actions slot */}
        {actions && (
          <div className="flex items-center gap-0.5 opacity-100 shrink-0">
            {actions}
          </div>
        )}
      </div>
    );
  }
);

BaseTabRow.displayName = "BaseTabRow";
