import { cn } from "@/lib/utils";
import type { Tag } from "@/lib/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface TagListProps {
  tags: Tag[];
  /** Maximum number of tags to show before "+N" overflow indicator */
  max?: number;
  className?: string;
  /** Whether tags should wrap to multiple lines (grid variant) */
  wrap?: boolean;
  /** Makes each tag a button; the click does not reach the surrounding card. */
  onTagClick?: (tagId: string) => void;
  /** Tags currently used as filters, announced with aria-pressed. */
  selectedTagIds?: readonly string[];
  pathByTagId?: ReadonlyMap<string, string>;
}

export function TagList({ tags, max = 3, className, wrap = false, onTagClick, selectedTagIds, pathByTagId }: TagListProps) {
  if (tags.length === 0) { return null; }

  const visible = tags.slice(0, max);
  const overflow = tags.length - max;

  return (
    <div className={cn("flex items-center gap-1", wrap && "flex-wrap", className)}>
      {visible.map((tag) => {
        const path = pathByTagId?.get(tag.id);
        const accessibleLabel = path ?? tag.name;
        const tagClass = cn("inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium", tag.color);

        const chip = onTagClick ? (
          <button
            key={tag.id}
            type="button"
            data-tag-id={tag.id}
            aria-label={accessibleLabel}
            aria-pressed={selectedTagIds?.includes(tag.id) ?? false}
            onClick={(event) => {
              event.stopPropagation();
              onTagClick(tag.id);
            }}
            onMouseDown={(event) => {
              event.stopPropagation();
            }}
            className={cn(
              tagClass,
              "cursor-pointer hover:opacity-80",
              (selectedTagIds?.includes(tag.id) ?? false) && "ring-1 ring-current"
            )}
          >
            {tag.name}
          </button>
        ) : (
          <span
            key={tag.id}
            tabIndex={path ? 0 : undefined}
            aria-label={accessibleLabel}
            onClick={(event) => {
              event.stopPropagation();
            }}
            onMouseDown={(event) => {
              event.stopPropagation();
            }}
            className={cn(tagClass, path && "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring")}
          >
            {tag.name}
          </span>
        );

        if (path) {
          return (
            <Tooltip key={tag.id}>
              <TooltipTrigger asChild>
                {chip}
              </TooltipTrigger>
              <TooltipContent side="top">{path}</TooltipContent>
            </Tooltip>
          );
        }

        return chip;
      })}
      {overflow > 0 && (
        <span className="text-[10px] text-muted-foreground py-0.5">
          +{overflow}{wrap ? " more" : ""}
        </span>
      )}
    </div>
  );
}
