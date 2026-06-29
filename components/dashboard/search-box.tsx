import * as React from "react";
import { Search, Archive, BookmarkIcon, Globe } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FaviconImage } from "@/components/ui/favicon-image";
import { useTabsStore } from "@/store/tabs-store";
import { useAuthStore } from "@/store/auth-store";
import { searchBookmarks } from "@/lib/api";
import type { SearchBookmark } from "@/lib/api";
import { analytics } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/hooks/use-translation";

interface SearchBoxProps {
  /** When provided, bookmark results are filtered to this collection. */
  collectionId?: string;
  size?: "sm" | "lg";
  className?: string;
}

export function SearchBox({ collectionId, size = "lg", className }: SearchBoxProps) {
  const { t } = useTranslation();
  const [query, setQuery] = React.useState("");
  const [bookmarkResults, setBookmarkResults] = React.useState<SearchBookmark[]>([]);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const openTabs = useTabsStore(s => s.openTabs);
  const accessToken = useAuthStore(s => s.accessToken);
  const serverUrl = useAuthStore(s => s.serverUrl);

  React.useEffect(() => {
    const handler = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("tabslate-focus-search", handler);
    return () => window.removeEventListener("tabslate-focus-search", handler);
  }, []);

  const filteredTabs = React.useMemo(() => {
    if (query.length < 2) { return []; }
    const lower = query.toLowerCase();
    return openTabs.filter(
      t => t.title.toLowerCase().includes(lower) || t.url.toLowerCase().includes(lower),
    );
  }, [openTabs, query]);

  const showDropdown = query.length >= 2;
  const totalItems = bookmarkResults.length + filteredTabs.length + 1;

  React.useEffect(() => {
    if (query.length < 2 || !accessToken) {
      setBookmarkResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await searchBookmarks(serverUrl, accessToken, query);
        const results = collectionId !== undefined
          ? res.bookmarks.filter(bm => bm.collectionId === collectionId)
          : res.bookmarks;
        setBookmarkResults(results);
      } catch {
        setBookmarkResults([]);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, accessToken, serverUrl, collectionId]);

  React.useEffect(() => { setActiveIndex(0); }, [bookmarkResults.length, filteredTabs.length]);

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setQuery("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const searchWeb = React.useCallback(() => {
    if (!query.trim()) { return; }
    analytics.track("search_used", { type: "web" });
    chrome.search.query({ text: query.trim(), disposition: "CURRENT_TAB" });
    setQuery("");
  }, [query]);

  const handleSelect = React.useCallback((index: number) => {
    if (index < filteredTabs.length) {
      analytics.track("search_used", { type: "tabs" });
      const tab = filteredTabs[index];
      chrome.tabs.update(tab.id, { active: true });
      chrome.windows.update(tab.windowId, { focused: true });
    } else if (index < filteredTabs.length + bookmarkResults.length) {
      analytics.track("search_used", { type: "bookmarks" });
      const url = bookmarkResults[index - filteredTabs.length].url;
      const existingTab = openTabs.find(t => t.url === url);
      if (existingTab) {
        chrome.tabs.update(existingTab.id, { active: true });
        chrome.windows.update(existingTab.windowId, { focused: true });
      } else {
        window.location.href = url;
      }
    } else {
      searchWeb();
      return;
    }
    setQuery("");
  }, [bookmarkResults, filteredTabs, openTabs, searchWeb]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showDropdown) { return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex(i => Math.min(i + 1, totalItems - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      if (e.nativeEvent.isComposing) { return; }
      e.preventDefault();
      handleSelect(activeIndex);
    } else if (e.key === "Escape") {
      setQuery("");
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    searchWeb();
  };

  const isActive = (idx: number) => idx === activeIndex;
  const webIndex = filteredTabs.length + bookmarkResults.length;
  const isLg = size === "lg";
  const placeholderEngineName = "the web";

  const placeholder = collectionId !== undefined
    ? t("search_placeholderCollection")
    : t("search_placeholderGlobal", [placeholderEngineName]);

  return (
    <div ref={wrapperRef} className={cn("relative", className)}>
      <form onSubmit={handleSearch} className="relative flex items-center w-full group">
        <div className={cn(
          "absolute left-1 z-10 flex items-center justify-center rounded-full pointer-events-none",
          isLg ? "size-12" : "size-8",
        )}>
          <Search className={cn("text-muted-foreground", isLg ? "size-5" : "size-4")} />
        </div>

        <Input
          ref={inputRef}
          type="text"
          name="q"
          autoComplete="off"
          placeholder={placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          className={cn(
            "w-full rounded-full bg-background/60 backdrop-blur-md border-muted/60 shadow-sm focus-visible:ring-1 focus-visible:ring-primary/50 transition-all",
            isLg ? "h-14 pl-14 pr-14 text-lg" : "h-10 pl-10 pr-10 text-sm",
          )}
        />

        <Button
          type="submit"
          variant="ghost"
          size="icon"
          className={cn(
            "absolute right-1 z-10 rounded-full text-muted-foreground hover:text-foreground focus-visible:ring-0",
            isLg ? "size-12" : "size-8",
          )}
        >
          <Search className={isLg ? "size-5" : "size-4"} />
        </Button>
      </form>

      {showDropdown && (
        <div
          className={cn(
            "absolute top-full z-50 rounded-2xl border border-muted-foreground/30 dark:border-zinc-700/80 bg-background/95 dark:bg-zinc-950/95 backdrop-blur-xl shadow-[0_20px_50px_rgba(0,0,0,0.25),0_0_30px_rgba(0,0,0,0.05)] dark:shadow-[0_30px_70px_rgba(0,0,0,0.95),0_0_35px_rgba(99,102,241,0.18),0_0_55px_rgba(168,85,247,0.12)] p-1.5 ring-1 ring-black/10 dark:ring-white/15 overflow-hidden flex flex-col",
            isLg ? "left-4 right-4 mt-3" : "left-0 right-0 mt-2",
          )}
          onWheel={(e) => e.stopPropagation()}
        >
          <div className={cn(
            "overflow-y-auto w-full flex flex-col gap-1 pr-1.5 transition-all",
            isLg ? "max-h-96" : "max-h-80",
          )}>
            {filteredTabs.length > 0 && (
              <section className="flex flex-col gap-1">
                <div className="px-3 py-2 text-[10px] font-bold text-muted-foreground/75 uppercase tracking-widest flex items-center gap-1.5 border-b border-muted/20 bg-muted/5 rounded-t-xl">
                  <Globe className="size-3 text-primary/80" />
                  {t("search_openTabs")} ({filteredTabs.length})
                </div>
                <div className={cn("py-1 flex flex-col gap-1", isLg ? "px-1.5" : "px-1")}>
                  {filteredTabs.map((tab, i) => (
                    <button
                      key={tab.id}
                      type="button"
                      className={cn(
                        "w-full flex items-center text-left transition-all duration-200 border border-transparent cursor-pointer rounded-xl",
                        isLg ? "gap-3 px-3 py-2" : "gap-2.5 px-2.5 py-1.5",
                        isActive(i)
                          ? "bg-primary/5 border-primary/10 dark:bg-primary/10 font-medium"
                          : "hover:bg-muted/40 hover:border-muted/30",
                      )}
                      onMouseEnter={() => setActiveIndex(i)}
                      onClick={() => handleSelect(i)}
                    >
                      <div className={cn(
                        "rounded-md bg-background/85 shadow-xs border border-muted/40 flex items-center justify-center shrink-0",
                        isLg ? "size-6" : "size-5",
                      )}>
                        <FaviconImage src={tab.favIconUrl} className={isLg ? "size-3.5" : "size-3"} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className={cn("font-medium truncate text-foreground", isLg ? "text-sm" : "text-xs")}>{tab.title}</div>
                        <div className={cn("text-muted-foreground/60 truncate mt-0.5", isLg ? "text-xs" : "text-[10px]")}>{tab.url}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {bookmarkResults.length > 0 && (
              <section className="flex flex-col gap-1">
                <div className="px-3 py-2 text-[10px] font-bold text-muted-foreground/75 uppercase tracking-widest flex items-center gap-1.5 border-b border-muted/20 bg-muted/5 rounded-t-xl">
                  <BookmarkIcon className="size-3 text-primary/80" />
                  {t("search_bookmarks")} ({bookmarkResults.length})
                </div>
                <div className={cn("py-1 flex flex-col gap-1", isLg ? "px-1.5" : "px-1")}>
                  {bookmarkResults.map((bm, i) => {
                    const flatIdx = filteredTabs.length + i;
                    return (
                      <button
                        key={bm.id}
                        type="button"
                        className={cn(
                          "w-full flex items-start text-left transition-all duration-200 border border-transparent cursor-pointer rounded-xl",
                          isLg ? "gap-3 px-3 py-2" : "gap-2.5 px-2.5 py-1.5",
                          isActive(flatIdx)
                            ? "bg-primary/5 border-primary/10 dark:bg-primary/10 font-medium"
                            : "hover:bg-muted/40 hover:border-muted/30",
                        )}
                        onMouseEnter={() => setActiveIndex(flatIdx)}
                        onClick={() => handleSelect(flatIdx)}
                      >
                        <div className={cn(
                          "rounded-md bg-background/85 shadow-xs border border-muted/40 flex items-center justify-center shrink-0 mt-0.5",
                          isLg ? "size-6" : "size-5",
                        )}>
                          <FaviconImage
                            src={(() => { try { return `https://www.google.com/s2/favicons?domain=${new URL(bm.url).hostname}&sz=16`; } catch { return ""; } })()}
                            className={isLg ? "size-3.5" : "size-3"}
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className={cn("font-medium truncate text-foreground", isLg ? "text-sm" : "text-xs")}>{bm.title}</span>
                            {bm.isArchived && (
                              <span className={cn("shrink-0 flex items-center gap-0.5 px-1 py-px rounded border border-muted/50 bg-muted/30 text-muted-foreground font-semibold", isLg ? "text-[9px]" : "text-[8px]")}>
                                <Archive className={isLg ? "size-2.5" : "size-2"} />
                                {t("search_archived")}
                              </span>
                            )}
                          </div>
                          <div className={cn("text-muted-foreground/60 truncate mt-0.5", isLg ? "text-xs" : "text-[10px]")}>{bm.url}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            <div className="border-t border-muted/20 px-1.5 py-1.5 mt-1 bg-muted/5">
              <button
                type="button"
                className={cn(
                  "w-full flex items-center text-left transition-all duration-200 border border-transparent cursor-pointer rounded-xl",
                  isLg ? "gap-3 px-3 py-2.5" : "gap-2.5 px-2.5 py-2",
                  isActive(webIndex)
                    ? "bg-primary/5 border-primary/10 dark:bg-primary/10 font-medium"
                    : "hover:bg-muted/40 hover:border-muted/30",
                )}
                onMouseEnter={() => setActiveIndex(webIndex)}
                onClick={() => handleSelect(webIndex)}
              >
                <div className={cn(
                  "rounded-md bg-background/85 shadow-xs border border-muted/40 flex items-center justify-center shrink-0",
                  isLg ? "size-6" : "size-5",
                )}>
                  <Search className={cn("text-muted-foreground", isLg ? "size-3.5" : "size-3")} />
                </div>
                <span className={cn("text-foreground", isLg ? "text-sm" : "text-xs")}>
                  {t("search_searchWeb", query)}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
