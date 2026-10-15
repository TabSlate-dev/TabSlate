import { cn } from "@/lib/utils";
import type { Tag } from "@/lib/types";

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
}

export function TagList({ tags, max = 3, className, wrap = false, onTagClick, selectedTagIds }: TagListProps) {
  if (tags.length === 0) { return null; }

  const visible = tags.slice(0, max);
  const overflow = tags.length - max;

  return (
    <div className={cn("flex items-center gap-1", wrap && "flex-wrap", className)}>
      {visible.map((tag) => {
        const tagClass = cn("inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium", tag.color);
        if (!onTagClick) {
          return (
            <span key={tag.id} className={tagClass}>
              {tag.name}
            </span>
          );
        }
        const selected = selectedTagIds?.includes(tag.id) ?? false;
        return (
          <button
            key={tag.id}
            type="button"
            data-tag-id={tag.id}
            aria-pressed={selected}
            onClick={(event) => {
              event.stopPropagation();
              onTagClick(tag.id);
            }}
            className={cn(tagClass, "cursor-pointer hover:opacity-80", selected && "ring-1 ring-current")}
          >
            {tag.name}
          </button>
        );
      })}
      {overflow > 0 && (
        <span className="text-[10px] text-muted-foreground py-0.5">
          +{overflow}{wrap ? " more" : ""}
        </span>
      )}
    </div>
  );
}
