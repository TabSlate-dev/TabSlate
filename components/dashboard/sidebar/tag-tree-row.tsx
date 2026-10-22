import * as React from "react";
import { Check, ChevronRight, FolderPlus, Move, Palette, Pencil, Split, Tag as TagIcon, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { TAG_COLORS } from "@/store/workspace-store";
import { useTranslation } from "@/hooks/use-translation";
import type { Tag } from "@/lib/types";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

function swatchClass(color: string): string {
  return color.split(" ")[0].replace("/10", "");
}

function HighlightedName({ name, query }: { name: string; query: string }) {
  const index = query ? name.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (index === -1) {
    return <>{name}</>;
  }
  return (
    <>
      {name.slice(0, index)}
      <mark className="rounded-sm bg-yellow-300/60 text-inherit dark:bg-yellow-500/40">
        {name.slice(index, index + query.length)}
      </mark>
      {name.slice(index + query.length)}
    </>
  );
}

export interface TagTreeRowProps {
  tag: Tag;
  depth: number;
  count: number;
  selected: boolean;
  expanded: boolean;
  hasChildren: boolean;
  query: string;
  onSelect: (tagId: string) => void;
  onToggleExpand: (tagId: string) => void;
  onNewChild: (tag: Tag) => void;
  onMove: (tag: Tag) => void;
  onMerge: (tag: Tag) => void;
  onEdit: (tag: Tag) => void;
  onColorChange: (tagId: string, color: string) => void;
  onDelete: (tag: Tag) => void;
}

export const TagTreeRow = React.memo(function TagTreeRow({
  tag,
  depth,
  count,
  selected,
  expanded,
  hasChildren,
  query,
  onSelect,
  onToggleExpand,
  onNewChild,
  onMove,
  onMerge,
  onEdit,
  onColorChange,
  onDelete,
}: TagTreeRowProps) {
  const { t } = useTranslation();

  return (
    <div
      className="flex items-center gap-1 w-full py-0.5"
      style={{ paddingLeft: `${depth * 14 + 2}px` }}
    >
      {hasChildren ? (
        <button
          type="button"
          aria-label={t(expanded ? "tagTree_collapseTag" : "tagTree_expandTag", [tag.name])}
          aria-expanded={expanded}
          onClick={(event) => {
            event.stopPropagation();
            onToggleExpand(tag.id);
          }}
          className="size-4 shrink-0 flex items-center justify-center text-muted-foreground hover:text-foreground rounded hover:bg-muted"
        >
          <ChevronRight className={cn("size-3 transition-transform", expanded && "rotate-90")} />
        </button>
      ) : (
        <span className="size-4 shrink-0" aria-hidden="true" />
      )}

      <Tooltip delayDuration={1000}>
        <ContextMenu>
          <TooltipTrigger asChild>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                data-tag-id={tag.id}
                aria-pressed={selected}
                onClick={() => onSelect(tag.id)}
                className={cn(
                  "inline-flex flex-1 items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium transition-colors text-left truncate",
                  selected ? "bg-primary text-primary-foreground" : tag.color,
                )}
              >
                <TagIcon className="size-3 shrink-0" />
                <span className="truncate flex-1">
                  <HighlightedName name={tag.name} query={query} />
                </span>
                <span
                  data-tag-count
                  className={cn("tabular-nums text-[10px] ml-1 shrink-0", count === 0 ? "opacity-50" : "opacity-80")}
                >
                  {count}
                </span>
              </button>
            </ContextMenuTrigger>
          </TooltipTrigger>
          <ContextMenuContent>
            <ContextMenuItem
              disabled={depth >= 4}
              onSelect={() => onNewChild(tag)}
            >
              <FolderPlus className="size-4" />
              {t("tagMenu_newChild")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onMove(tag)}>
              <Move className="size-4" />
              {t("tagMenu_move")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onMerge(tag)}>
              <Split className="size-4" />
              {t("tagMenu_merge")}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onEdit(tag)}>
              <Pencil className="size-4" />
              {t("tagMenu_rename")}
            </ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <Palette className="size-4" />
                {t("tagMenu_color")}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {TAG_COLORS.map((color, index) => (
                  <ContextMenuItem key={color} onSelect={() => onColorChange(tag.id, color)}>
                    <span className={cn("size-3 rounded-full", swatchClass(color))} />
                    {t("tagDialog_colorOption", [String(index + 1)])}
                    {tag.color === color && <Check className="ml-auto size-4" />}
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={() => onDelete(tag)}>
              <Trash2 className="size-4" />
              {t("tagMenu_delete")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <TooltipContent side="top">{t("sidebar_tagRightClickHint")}</TooltipContent>
      </Tooltip>
    </div>
  );
});
