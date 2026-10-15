import * as React from "react";
import { X } from "lucide-react";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { useTranslation } from "@/hooks/use-translation";

interface ActiveFilterChipsProps {
  /** Also shows the bookmark type filter, which only the library applies. */
  includeTypeFilter?: boolean;
}

/** The selected tags, and optionally the type filter, as removable chips with a control that clears them all. */
export function ActiveFilterChips({ includeTypeFilter = false }: ActiveFilterChipsProps) {
  const { t } = useTranslation();
  const selectedTags = useBookmarksStore((s) => s.selectedTags);
  const toggleTag = useBookmarksStore((s) => s.toggleTag);
  const clearTags = useBookmarksStore((s) => s.clearTags);
  const storeFilterType = useBookmarksStore((s) => s.filterType);
  const setFilterType = useBookmarksStore((s) => s.setFilterType);
  const tags = useWorkspaceStore((s) => s.tags);

  const activeTags = React.useMemo(
    () => tags.filter((tag) => selectedTags.includes(tag.id)),
    [tags, selectedTags],
  );
  const filterType = includeTypeFilter ? storeFilterType : "all";

  if (activeTags.length === 0 && filterType === "all") {
    return null;
  }

  const handleClearAll = () => {
    clearTags();
    if (includeTypeFilter) {
      setFilterType("all");
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {filterType !== "all" && (
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-primary/10 text-primary">
          {filterType === "favorites" && t("bookmarksContent_favoritesOnly")}
          {filterType === "with-tags" && t("bookmarksContent_withTags")}
          {filterType === "without-tags" && t("bookmarksContent_withoutTags")}
          <button
            type="button"
            aria-label={t("activeFilterChips_removeTypeFilter")}
            onClick={() => setFilterType("all")}
            className="hover:bg-primary/20 rounded-full p-0.5"
          >
            <X className="size-3" />
          </button>
        </span>
      )}
      {activeTags.map((tag) => (
        <span
          key={tag.id}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-primary text-primary-foreground"
        >
          {tag.name}
          <button
            type="button"
            aria-label={t("activeFilterChips_removeTag", [tag.name])}
            onClick={() => toggleTag(tag.id)}
            className="hover:bg-primary-foreground/20 rounded-full p-0.5"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={handleClearAll}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {t("activeFilterChips_clearAll")}
      </button>
    </div>
  );
}
