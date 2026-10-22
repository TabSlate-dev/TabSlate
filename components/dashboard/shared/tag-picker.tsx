import * as React from "react";
import { X } from "lucide-react";
import { FilterableList } from "@/components/dashboard/shared/filterable-list";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTagTree } from "@/hooks/use-tag-tree";
import { useTranslation } from "@/hooks/use-translation";
import { normalizeTagName } from "@/lib/tag-name";
import { displayTagPath, resolveTagPath, searchTagPaths } from "@/lib/tag-tree";
import type { Tag } from "@/lib/types";
import { cn } from "@/lib/utils";
import { TAG_COLORS, useWorkspaceStore } from "@/store/workspace-store";

interface TagPickerProps {
  /** Selected tag IDs, in the order they were added. */
  value: readonly string[];
  onChange: (tagIds: string[]) => void;
  inputId?: string;
  autoFocus?: boolean;
}

function solidColor(color: string): string {
  return color.split(" ")[0]?.replace("/10", "") ?? "bg-muted";
}

/**
 * Selected tags as removable chips plus a filter field. Enter picks the
 * highlighted tag or creates a new one; Backspace in an empty field removes
 * the last chip; Esc hides the suggestions until the user types again. A tag
 * the quota blocks is not added.
 */
export function TagPicker({ value, onChange, inputId, autoFocus }: TagPickerProps) {
  const { t } = useTranslation();
  const tree = useTagTree();
  const tags = useWorkspaceStore((s) => s.tags);
  const createTagPath = useWorkspaceStore((s) => s.createTagPath);
  const [pending, setPending] = React.useState(false);
  const pendingRef = React.useRef(false);
  const selectionRef = React.useRef({ value, onChange });
  selectionRef.current = { value, onChange };
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [focused, setFocused] = React.useState(false);
  const [dismissed, setDismissed] = React.useState(false);

  const tagsById = React.useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags]);
  const selectedTags = React.useMemo(
    () => value.map((id) => tagsById.get(id)).filter((tag): tag is Tag => tag !== undefined),
    [value, tagsById],
  );

  const items = React.useMemo(() => {
    const trimmed = query.trim();
    const sourceTags = trimmed
      ? searchTagPaths(tree, trimmed)
      : tags;
    return sourceTags
      .filter((tag) => !value.includes(tag.id))
      .map((tag) => ({
        id: tag.id,
        label: displayTagPath(tree, tag.id) || tag.name,
        color: tag.color,
      }));
  }, [query, tree, tags, value]);

  const hasExactMatch = React.useCallback(
    (q: string) => {
      const trimmed = q.trim();
      if (!trimmed) {
        return true;
      }
      if (!trimmed.includes("/")) {
        return tags.some((tag) => normalizeTagName(tag.name) === normalizeTagName(trimmed));
      }
      if (tags.some((tag) => normalizeTagName(tag.name) === normalizeTagName(trimmed))) {
        return true;
      }
      const resolved = resolveTagPath(tree, trimmed, undefined, "color", () => "id");
      return resolved.ok && resolved.created.length === 0;
    },
    [tags, tree],
  );

  const create = React.useMemo(() => ({
    canCreate: (input: string) => {
      if (pending) {
        return false;
      }
      const trimmed = input.trim();
      if (!trimmed) {
        return false;
      }
      const resolved = resolveTagPath(tree, trimmed, undefined, "color", () => "id");
      return resolved.ok;
    },
    onCreate: async (input: string) => {
      if (pendingRef.current) {
        return;
      }
      pendingRef.current = true;
      setPending(true);
      setError(null);
      try {
        const rootColor = TAG_COLORS[tags.length % TAG_COLORS.length];
        const result = await createTagPath(input.trim(), rootColor);
        if (!result.ok) {
          setError(
            t(
              result.error === "storage"
                ? "tagAction_errorStorage"
                : result.error === "stale"
                  ? "tagAction_errorStale"
                  : result.error === "quota"
                    ? "tagAction_errorQuota"
                    : result.error === "depth"
                      ? "tagAction_errorDepth"
                      : "tagAction_errorInvalid",
            ),
          );
          return;
        }
        if (!result.tagId) {
          return;
        }
        const current = selectionRef.current;
        if (!current.value.includes(result.tagId)) {
          current.onChange([...current.value, result.tagId]);
        }
        setQuery("");
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
  }), [pending, tree, tags.length, createTagPath, t]);

  const handleActivate = (item: { id: string }) => {
    onChange([...value, item.id]);
    setQuery("");
  };

  const handleQueryChange = (next: string) => {
    setQuery(next);
    setDismissed(false);
  };

  const handleInputFocus = () => {
    setFocused(true);
    setDismissed(false);
  };

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // The dialog lets an Esc aimed at open suggestions through to here.
    if (event.key === "Escape") {
      setDismissed(true);
      return;
    }
    if (event.key === "Backspace" && query === "" && value.length > 0) {
      event.preventDefault();
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {selectedTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedTags.map((tag) => {
            const path = displayTagPath(tree, tag.id) || tag.name;
            return (
              <Tooltip key={tag.id}>
                <TooltipTrigger asChild>
                  <span
                    className={cn("inline-flex items-center gap-1 rounded-full py-0.5 pl-2.5 pr-1 text-xs font-medium", tag.color)}
                  >
                    {tag.name}
                    <button
                      type="button"
                      aria-label={t("tagPicker_remove", [tag.name])}
                      onClick={() => onChange(value.filter((id) => id !== tag.id))}
                      className="rounded-full p-0.5 hover:bg-foreground/10"
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">{path}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      )}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <FilterableList
        items={items}
        query={query}
        onQueryChange={handleQueryChange}
        onActivate={handleActivate}
        matchesQuery={() => true}
        hasExactMatch={hasExactMatch}
        create={create}
        renderItem={(item) => (
          <>
            <span className={cn("size-2.5 shrink-0 rounded-full", solidColor(item.color))} />
            <span className="truncate">{item.label}</span>
          </>
        )}
        placeholder={t("tagPicker_placeholder")}
        emptyText={t("tagPicker_empty")}
        listHidden={!focused || dismissed}
        inputId={inputId}
        autoFocus={autoFocus}
        onInputKeyDown={handleInputKeyDown}
        onInputFocus={handleInputFocus}
        onInputBlur={() => setFocused(false)}
        listClassName="rounded-md border p-1"
      />
    </div>
  );
}
