import * as React from "react";
import { ChevronRight, Folder, Tag as TagIcon, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { tagAncestors, type TagTree } from "@/lib/tag-tree";
import { useTranslation } from "@/hooks/use-translation";

export const TAG_TREE_ROOT_ID = "__root__";

export interface TagTreePickerProps {
  tree: TagTree;
  value: string | undefined;
  onChange: (parentId: string | undefined) => void;
  disabledReason: (tagId: string | undefined) => string | undefined;
  includeTopLevel?: boolean;
  label: string;
}

interface FlattenedRow {
  key: string;
  id: string | undefined;
  tagIdAttr: string;
  name: string;
  depth: number;
  hasChildren: boolean;
  color?: string;
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const index = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (index === -1) {
    return <>{text}</>;
  }
  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded-sm bg-yellow-300/60 text-inherit dark:bg-yellow-500/40">
        {text.slice(index, index + query.length)}
      </mark>
      {text.slice(index + query.length)}
    </>
  );
}

export function TagTreePicker({
  tree,
  value,
  onChange,
  disabledReason,
  includeTopLevel = true,
  label,
}: TagTreePickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = React.useState("");
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(() => new Set());
  const [activeIndex, setActiveIndex] = React.useState(0);

  const trimmedQuery = query.trim();

  // If query is present, expand all matching nodes' ancestors
  const effectiveExpandedIds = React.useMemo(() => {
    const set = new Set(expandedIds);
    const needle = trimmedQuery.toLowerCase();
    if (needle) {
      for (const [id, tag] of tree.tagsById) {
        if (tag.name.toLowerCase().includes(needle)) {
          for (const ancestor of tagAncestors(tree, id)) {
            set.add(ancestor);
          }
        }
      }
    }
    return set;
  }, [expandedIds, trimmedQuery, tree]);

  const toggleExpand = React.useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // Compute matching IDs when query is active
  const matchingOrAncestorIds = React.useMemo(() => {
    const needle = trimmedQuery.toLowerCase();
    if (!needle) {
      return null;
    }
    const matching = new Set<string>();
    for (const [id, tag] of tree.tagsById) {
      if (tag.name.toLowerCase().includes(needle)) {
        matching.add(id);
        for (const ancestor of tagAncestors(tree, id)) {
          matching.add(ancestor);
        }
      }
    }
    return matching;
  }, [trimmedQuery, tree]);

  // Flatten the tree into visible rows
  const visibleRows = React.useMemo(() => {
    const rows: FlattenedRow[] = [];

    if (includeTopLevel) {
      const rootMatches =
        !matchingOrAncestorIds ||
        t("tagTreePicker_root").toLowerCase().includes(trimmedQuery.toLowerCase());
      if (rootMatches) {
        rows.push({
          key: TAG_TREE_ROOT_ID,
          id: undefined,
          tagIdAttr: TAG_TREE_ROOT_ID,
          name: t("tagTreePicker_root"),
          depth: 0,
          hasChildren: false,
        });
      }
    }

    const traverse = (parentId: string | undefined, depth: number) => {
      const children = tree.childrenByParent.get(parentId) ?? [];
      for (const childId of children) {
        if (matchingOrAncestorIds && !matchingOrAncestorIds.has(childId)) {
          continue;
        }
        const tag = tree.tagsById.get(childId);
        if (!tag) {
          continue;
        }
        const hasChildren = (tree.childrenByParent.get(childId) ?? []).length > 0;
        rows.push({
          key: childId,
          id: childId,
          tagIdAttr: childId,
          name: tag.name,
          depth,
          hasChildren,
          color: tag.color,
        });
        if (hasChildren && effectiveExpandedIds.has(childId)) {
          traverse(childId, depth + 1);
        }
      }
    };

    traverse(undefined, 0);
    return rows;
  }, [tree, includeTopLevel, matchingOrAncestorIds, effectiveExpandedIds, t, trimmedQuery]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((prev) => (prev + 1 < visibleRows.length ? prev + 1 : prev));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((prev) => (prev > 0 ? prev - 1 : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const targetRow = visibleRows[activeIndex];
      if (targetRow) {
        const reason = disabledReason(targetRow.id);
        if (!reason) {
          onChange(targetRow.id);
        }
      }
    }
  };

  return (
    <div className="space-y-2" role="region" aria-label={label}>
      <div className="relative">
        <Input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder={t("tagTreePicker_searchPlaceholder")}
          aria-label={t("tagTreePicker_search")}
          className="h-8 text-xs pr-7"
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setActiveIndex(0);
            }}
            aria-label={t("settings_cancel")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      <div
        role="tree"
        aria-label={label}
        className="max-h-56 overflow-y-auto rounded-md border p-1 space-y-0.5 text-xs"
      >
        {visibleRows.length === 0 ? (
          <p className="p-2 text-center text-muted-foreground">{t("tagTreePicker_empty")}</p>
        ) : (
          visibleRows.map((row, index) => {
            const reason = disabledReason(row.id);
            const isDisabled = Boolean(reason);
            const isSelected = row.id === undefined ? value === undefined : value === row.id;
            const isExpanded = row.id ? effectiveExpandedIds.has(row.id) : false;
            const isActive = index === activeIndex;

            return (
              <div
                key={row.key}
                role="treeitem"
                aria-selected={isSelected}
                className={cn(
                  "flex items-center gap-1 rounded-sm px-1 py-1 transition-colors",
                  isActive && "bg-accent/40",
                )}
                style={{ paddingLeft: `${row.depth * 14 + 4}px` }}
              >
                {row.hasChildren && row.id ? (
                  <button
                    type="button"
                    aria-label={t(isExpanded ? "tagTree_collapseTag" : "tagTree_expandTag", [row.name])}
                    aria-expanded={isExpanded}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleExpand(row.id as string);
                    }}
                    className="size-4 shrink-0 flex items-center justify-center text-muted-foreground hover:text-foreground rounded hover:bg-muted"
                  >
                    <ChevronRight className={cn("size-3 transition-transform", isExpanded && "rotate-90")} />
                  </button>
                ) : (
                  <span className="size-4 shrink-0" aria-hidden="true" />
                )}

                <button
                  type="button"
                  data-tag-id={row.tagIdAttr}
                  aria-pressed={isSelected}
                  aria-disabled={isDisabled}
                  disabled={isDisabled}
                  onClick={() => {
                    if (!isDisabled) {
                      onChange(row.id);
                    }
                  }}
                  className={cn(
                    "flex flex-1 items-center gap-1.5 text-left rounded px-1.5 py-0.5 transition-colors",
                    isSelected ? "bg-primary text-primary-foreground font-medium" : "hover:bg-muted/60",
                    isDisabled && "opacity-40 cursor-not-allowed hover:bg-transparent",
                  )}
                >
                  {row.id === undefined ? (
                    <Folder className="size-3 shrink-0 opacity-70" />
                  ) : (
                    <TagIcon className="size-3 shrink-0 opacity-70" />
                  )}
                  <span className="truncate flex-1">
                    <HighlightedText text={row.name} query={trimmedQuery} />
                  </span>
                  {reason && (
                    <span className="text-[10px] text-muted-foreground truncate max-w-[120px]" title={t(reason)}>
                      {t(reason)}
                    </span>
                  )}
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
