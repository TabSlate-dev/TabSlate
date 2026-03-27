/**
 * BookmarkCardAd — 纯展示版书签卡片，用于广告/推广/预览场景。
 * 样式与 v1 bookmark-card 一致，无 store 依赖，全部通过 props 传入。
 */
import { FaviconImage } from "@/components/ui/favicon-image";
import { TagList } from "@/components/ui/tag-list";
import { Heart } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Tag } from "@/lib/types";

interface BookmarkCardAdProps {
  title: string;
  url: string;
  favicon?: string;
  description?: string;
  tags?: Tag[];
  isFavorite?: boolean;
  hasDarkIcon?: boolean;
  /** "grid" renders the tall card with favicon banner; "list" renders a compact row */
  variant?: "grid" | "list";
  className?: string;
}

export function BookmarkCardAd({
  title,
  url,
  favicon = "",
  description = "",
  tags = [],
  isFavorite = false,
  hasDarkIcon,
  variant = "grid",
  className,
}: BookmarkCardAdProps) {
  const hostname = (() => {
    try { return new URL(url).hostname; } catch { return url; }
  })();

  if (variant === "list") {
    return (
      <div
        className={cn(
          "flex items-center gap-4 p-4 rounded-lg border bg-card",
          className
        )}
      >
        <div className="size-10 rounded-lg bg-muted flex items-center justify-center overflow-hidden shrink-0">
          <FaviconImage src={favicon} alt={title} className="size-6" hasDarkIcon={hasDarkIcon} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-medium truncate">{title}</h3>
            <TagList tags={tags} max={2} className="hidden sm:flex" />
          </div>
          <p className="text-sm text-muted-foreground truncate">{hostname}</p>
        </div>

        <Heart
          className={cn("size-4 shrink-0", isFavorite ? "fill-red-500 text-red-500" : "text-muted-foreground")}
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative flex flex-col rounded-xl border bg-card overflow-hidden",
        className
      )}
    >
      {/* Favorite indicator */}
      <div className="absolute top-3 right-3 z-10">
        <Heart
          className={cn("size-4", isFavorite ? "fill-red-500 text-red-500" : "text-muted-foreground/50")}
        />
      </div>

      {/* Favicon banner */}
      <div className="h-32 bg-linear-to-br from-muted/50 to-muted flex items-center justify-center">
        <div className="size-12 rounded-xl bg-background shadow-sm flex items-center justify-center">
          <FaviconImage src={favicon} alt={title} className="size-8" hasDarkIcon={hasDarkIcon} />
        </div>
      </div>

      {/* Body */}
      <div className="p-4 space-y-2">
        <h3 className="font-medium line-clamp-1">{title}</h3>
        <p className="text-sm text-muted-foreground line-clamp-2">{description || hostname}</p>
        <TagList tags={tags} max={3} wrap className="pt-1" />
      </div>
    </div>
  );
}
