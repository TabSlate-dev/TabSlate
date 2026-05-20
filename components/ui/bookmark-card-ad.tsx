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
        "relative z-0 hover:z-10 flex flex-col rounded-xl border border-muted/60 bg-gradient-to-br from-background/90 to-muted/40 backdrop-blur-md shadow-sm transition-all duration-500 hover:shadow-lg group h-full",
        className
      )}
    >
      {/* Outer Glow Effect on Hover */}
      <div className="absolute inset-0 bg-gradient-to-r from-primary/20 to-purple-500/20 opacity-0 group-hover:opacity-100 transition-opacity duration-500 blur-md z-[-1] rounded-xl pointer-events-none" />

      {/* Crisp Background Icon Fading to Left */}
      <div 
        className="absolute inset-y-0 -right-4 w-3/4 z-0 pointer-events-none select-none overflow-hidden rounded-r-xl opacity-40 dark:opacity-30 group-hover:opacity-80 transition-opacity duration-500"
        style={{ WebkitMaskImage: 'linear-gradient(to left, rgba(0,0,0,1) 10%, rgba(0,0,0,0) 100%)', maskImage: 'linear-gradient(to left, rgba(0,0,0,1) 10%, rgba(0,0,0,0) 100%)' }}
      >
        <div className="absolute top-1/2 right-0 -translate-y-1/2 w-56 h-56 flex items-center justify-center">
          <FaviconImage 
            src={favicon} 
            alt="" 
            className="w-full h-full object-cover -rotate-[15deg] scale-110 drop-shadow-xl [image-rendering:pixelated] dark:brightness-150" 
            hasDarkIcon={hasDarkIcon} 
          />
        </div>
      </div>

      {/* Favorite indicator */}
      <div className="absolute top-4 right-4 z-20">
        <Heart
          className={cn("size-4", isFavorite ? "fill-red-500 text-red-500" : "text-muted-foreground/50 transition-colors group-hover:text-muted-foreground")}
        />
      </div>

      {/* Body Content */}
      <div className="relative z-10 flex flex-col p-5 pt-6 h-full min-h-[160px]">
        <div className="flex items-start gap-3 mb-3 pr-8">
          <div className="size-10 rounded-xl bg-background/80 backdrop-blur-md border shadow-sm flex items-center justify-center shrink-0 transition-transform duration-300 group-hover:scale-105 group-hover:shadow-md">
            <FaviconImage src={favicon} alt={title} className="size-6" hasDarkIcon={hasDarkIcon} />
          </div>
          <h3 className="font-semibold text-base line-clamp-2 leading-tight mt-1 text-foreground drop-shadow-sm">
            {title}
          </h3>
        </div>
        <div className="mt-auto flex flex-col gap-3">
          <p className="text-sm text-foreground/70 line-clamp-2 leading-relaxed">
            {description || hostname}
          </p>
          {tags && tags.length > 0 && (
            <TagList tags={tags} max={3} wrap className="pt-1" />
          )}
        </div>
      </div>
    </div>
  );
}
