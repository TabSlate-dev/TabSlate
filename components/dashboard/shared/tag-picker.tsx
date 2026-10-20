import * as React from "react";
import { X } from "lucide-react";
import { FilterableList } from "@/components/dashboard/shared/filterable-list";
import { useTranslation } from "@/hooks/use-translation";
import { tagNameError } from "@/lib/tag-name";
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
 * the last chip. A tag the quota blocks is not added.
 */
export function TagPicker({ value, onChange, inputId, autoFocus }: TagPickerProps) {
  const { t } = useTranslation();
  const tags = useWorkspaceStore((s) => s.tags);
  const createTag = useWorkspaceStore((s) => s.createTag);
  const [query, setQuery] = React.useState("");
  const [focused, setFocused] = React.useState(false);

  const tagsById = React.useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags]);
  const selectedTags = React.useMemo(
    () => value.map((id) => tagsById.get(id)).filter((tag): tag is Tag => tag !== undefined),
    [value, tagsById],
  );
  const items = React.useMemo(
    () => tags.filter((tag) => !value.includes(tag.id)).map((tag) => ({ id: tag.id, label: tag.name, color: tag.color })),
    [tags, value],
  );
  const tagNames = React.useMemo(() => tags.map((tag) => tag.name), [tags]);
  const create = React.useMemo(() => ({
    canCreate: (name: string) => tagNameError(name, tagNames) === null,
    onCreate: (name: string) => {
      const tag = createTag(name, TAG_COLORS[tags.length % TAG_COLORS.length]);
      // An empty ID means the quota blocked it; the quota alert says so.
      if (!tag.id) {
        return;
      }
      onChange([...value, tag.id]);
      setQuery("");
    },
  }), [tagNames, createTag, tags.length, onChange, value]);

  const handleActivate = (item: { id: string }) => {
    onChange([...value, item.id]);
    setQuery("");
  };

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Backspace" && query === "" && value.length > 0) {
      event.preventDefault();
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {selectedTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedTags.map((tag) => (
            <span
              key={tag.id}
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
          ))}
        </div>
      )}
      <FilterableList
        items={items}
        query={query}
        onQueryChange={setQuery}
        onActivate={handleActivate}
        create={create}
        renderItem={(item) => (
          <>
            <span className={cn("size-2.5 shrink-0 rounded-full", solidColor(item.color))} />
            <span className="truncate">{item.label}</span>
          </>
        )}
        placeholder={t("tagPicker_placeholder")}
        emptyText={t("tagPicker_empty")}
        listHidden={!focused}
        inputId={inputId}
        autoFocus={autoFocus}
        onInputKeyDown={handleInputKeyDown}
        onInputFocus={() => setFocused(true)}
        onInputBlur={() => setFocused(false)}
        listClassName="rounded-md border p-1"
      />
    </div>
  );
}
