

import { useState } from "react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ThemeToggle } from "@/components/theme-toggle";
import { LanguageSelector } from "@/components/language-selector";
import { useTranslation } from "@/hooks/use-translation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import {
  Search,
  LayoutGrid,
  List,
  Plus,
  SlidersHorizontal,
  ArrowUpDown,
  GitBranch,
  Check,
} from "lucide-react";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { cn } from "@/lib/utils";
import { AddBookmarkDialog } from "@/components/dashboard/add-bookmark-dialog";


interface BookmarksHeaderProps {
  title?: string;
}

const sortOptions = [
  { value: "date-newest", labelKey: "header_sortDateNewest" },
  { value: "date-oldest", labelKey: "header_sortDateOldest" },
  { value: "alpha-az", labelKey: "header_sortAlphaAZ" },
  { value: "alpha-za", labelKey: "header_sortAlphaZA" },
] as const;

const filterOptions = [
  { value: "all", labelKey: "header_filterAll" },
  { value: "favorites", labelKey: "header_filterFavorites" },
  { value: "with-tags", labelKey: "header_filterWithTags" },
  { value: "without-tags", labelKey: "header_filterWithoutTags" },
] as const;

export function BookmarksHeader({ title }: BookmarksHeaderProps) {
  const { t } = useTranslation();
  const {
    viewMode,
    setViewMode,
    searchQuery,
    setSearchQuery,
    sortBy,
    setSortBy,
    filterType,
    setFilterType,
  } = useBookmarksStore();

  const [addBookmarkOpen, setAddBookmarkOpen] = useState(false);

  const currentSort = sortOptions.find((opt) => opt.value === sortBy);
  const currentFilter = filterOptions.find((opt) => opt.value === filterType);
  const displayTitle = title ?? t("header_titleBookmarks");

  return (
    <header className="w-full border-b">
      <div className="flex items-center justify-between h-14 px-4">
        <div className="flex items-center gap-3">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-5" />
          <h1 className="text-base font-semibold hidden sm:block">{displayTitle}</h1>
        </div>

        <div className="flex items-center gap-2">
          {/* 
          <div className="relative hidden md:block">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 w-64 h-9"
            />
          </div>
          */}

          <div className="flex items-center border rounded-md p-0.5">
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn("rounded-sm", viewMode === "grid" && "bg-muted")}
              onClick={() => setViewMode("grid")}
            >
              <LayoutGrid className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn("rounded-sm", viewMode === "list" && "bg-muted")}
              onClick={() => setViewMode("list")}
            >
              <List className="size-4" />
            </Button>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="hidden sm:flex">
                <ArrowUpDown className="size-4" />
                <span className="hidden lg:inline">{t(currentSort?.labelKey || "header_sortDateNewest").split(" ")[0]}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {t("header_sortBy")}
              </DropdownMenuLabel>
              {sortOptions.map((option) => (
                <DropdownMenuItem
                  key={option.value}
                  onClick={() => setSortBy(option.value)}
                  className="flex items-center justify-between"
                >
                  {t(option.labelKey)}
                  {sortBy === option.value && <Check className="size-4" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "hidden sm:flex",
                  filterType !== "all" && "border-primary text-primary"
                )}
              >
                <SlidersHorizontal className="size-4" />
                <span className="hidden lg:inline">
                  {filterType !== "all" && currentFilter ? t(currentFilter.labelKey) : t("header_filter")}
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {t("header_filterBy")}
              </DropdownMenuLabel>
              {filterOptions.map((option) => (
                <DropdownMenuItem
                  key={option.value}
                  onClick={() => setFilterType(option.value)}
                  className="flex items-center justify-between"
                >
                  {t(option.labelKey)}
                  {filterType === option.value && <Check className="size-4" />}
                </DropdownMenuItem>
              ))}
              {filterType !== "all" && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => setFilterType("all")}
                    className="text-muted-foreground"
                  >
                    {t("header_clearFilter")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <Button size="sm" className="hidden sm:flex" onClick={() => setAddBookmarkOpen(true)}>
            <Plus className="size-4" />
            {t("header_addBookmark")}
          </Button>

          <Separator orientation="vertical" className="h-5 hidden sm:block" />

          <ThemeToggle />
          <LanguageSelector />

          <Button variant="ghost" size="icon" asChild>
            <a
              href="https://github.com/ln-dev7/square-ui"
              target="_blank"
              rel="noopener noreferrer"
            >
              <GitBranch className="size-5" />
            </a>
          </Button>
        </div>
      </div>

      <AddBookmarkDialog open={addBookmarkOpen} onOpenChange={setAddBookmarkOpen} />
    </header>
  );
}
