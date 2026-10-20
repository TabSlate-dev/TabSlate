import * as React from "react";
import { Check, Minus, Tag as TagIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { FilterableList } from "@/components/dashboard/shared/filterable-list";
import { useTranslation } from "@/hooks/use-translation";
import { bulkTagPatches, nextTagCheckState, tagCheckStates, type TagCheckState } from "@/lib/bulk-tags";
import { tagNameError } from "@/lib/tag-name";
import type { Bookmark } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { TAG_COLORS, useWorkspaceStore } from "@/store/workspace-store";

interface BulkTagsMenuProps {
  /** The selected bookmarks. */
  bookmarks: readonly Bookmark[];
}

function ariaChecked(state: TagCheckState): boolean | "mixed" {
  return state === "indeterminate" ? "mixed" : state === "checked";
}

interface TagCheckRowProps {
  state: TagCheckState;
  label: string;
}

function TagCheckRow({ state, label }: TagCheckRowProps) {
  return (
    <>
      <span
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-sm border",
          state === "unchecked" ? "border-muted-foreground/60" : "border-primary bg-primary text-primary-foreground",
        )}
      >
        {state === "checked" && <Check className="size-3" />}
        {state === "indeterminate" && <Minus className="size-3" />}
      </span>
      <span className="truncate">{label}</span>
    </>
  );
}

/**
 * Three-state tag rows computed from the selection. Rows the user clicks are
 * applied to every selected bookmark in one update when they press Apply;
 * other rows keep each bookmark's tags.
 */
export function BulkTagsMenu({ bookmarks }: BulkTagsMenuProps) {
  const { t } = useTranslation();
  const tags = useWorkspaceStore((s) => s.tags);
  const createTag = useWorkspaceStore((s) => s.createTag);
  const updateBookmarks = useBookmarksStore((s) => s.updateBookmarks);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [changes, setChanges] = React.useState<ReadonlyMap<string, TagCheckState>>(new Map());

  const initial = React.useMemo(() => tagCheckStates(bookmarks, tags.map((tag) => tag.id)), [bookmarks, tags]);
  const items = React.useMemo(() => tags.map((tag) => ({ id: tag.id, label: tag.name })), [tags]);
  const tagNames = React.useMemo(() => tags.map((tag) => tag.name), [tags]);
  const stateOf = (tagId: string): TagCheckState => changes.get(tagId) ?? initial.get(tagId) ?? "unchecked";

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery("");
      setChanges(new Map());
    }
  };

  const handleToggle = (item: { id: string }) => {
    setChanges((current) => new Map(current).set(item.id, nextTagCheckState(current.get(item.id) ?? initial.get(item.id) ?? "unchecked")));
  };

  const create = {
    canCreate: (name: string) => tagNameError(name, tagNames) === null,
    onCreate: (name: string) => {
      const tag = createTag(name, TAG_COLORS[tags.length % TAG_COLORS.length]);
      // An empty ID means the quota blocked it; the quota alert says so.
      if (!tag.id) {
        return;
      }
      setChanges((current) => new Map(current).set(tag.id, "checked"));
      setQuery("");
    },
  };

  const handleApply = () => {
    updateBookmarks(bulkTagPatches(bookmarks, changes));
    handleOpenChange(false);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          <TagIcon className="size-4" />
          {t("bulkActions_tags")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-64 p-2">
        <FilterableList
          items={items}
          query={query}
          onQueryChange={setQuery}
          onActivate={handleToggle}
          create={create}
          renderItem={(item) => <TagCheckRow state={stateOf(item.id)} label={item.label} />}
          itemAria={(item) => ({ "aria-checked": ariaChecked(stateOf(item.id)) })}
          placeholder={t("bulkTags_filterPlaceholder")}
          emptyText={t("bulkTags_empty")}
          autoFocus
        />
        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
            {t("settings_cancel")}
          </Button>
          <Button type="button" size="sm" disabled={changes.size === 0} onClick={handleApply}>
            {t("bulkTags_apply")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
