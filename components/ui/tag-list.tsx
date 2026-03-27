import { cn } from "@/lib/utils";
import type { Tag } from "@/lib/types";

interface TagListProps {
  tags: Tag[];
  /** Maximum number of tags to show before "+N" overflow indicator */
  max?: number;
  className?: string;
  /** Whether tags should wrap to multiple lines (grid variant) */
  wrap?: boolean;
}

export function TagList({ tags, max = 3, className, wrap = false }: TagListProps) {
  if (tags.length === 0) return null;

  const visible = tags.slice(0, max);
  const overflow = tags.length - max;

  return (
    <div className={cn("flex items-center gap-1", wrap && "flex-wrap", className)}>
      {visible.map((tag) => (
        <span
          key={tag.id}
          className={cn(
            "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium",
            tag.color
          )}
        >
          {tag.name}
        </span>
      ))}
      {overflow > 0 && (
        <span className="text-[10px] text-muted-foreground py-0.5">
          +{overflow}{wrap ? " more" : ""}
        </span>
      )}
    </div>
  );
}
