import * as React from "react";
import { Search, Archive, BookmarkIcon, Globe } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { FaviconImage } from "@/components/ui/favicon-image";
import { AdBanner } from "@/components/dashboard/ad-banner";
import { useTabsStore } from "@/store/tabs-store";
import { useAuthStore } from "@/store/auth-store";
import { searchBookmarks } from "@/lib/api";
import type { SearchBookmark } from "@/lib/api";
import { cn } from "@/lib/utils";

import { useSettingsStore } from "@/store/settings-store";



function getEngineIconSrc(engine: { iconUrl?: string; siteUrl: string }): string {
  if (engine.iconUrl && typeof chrome !== "undefined" && chrome.runtime?.id) {
    return chrome.runtime.getURL(engine.iconUrl);
  }
  try {
    const domain = new URL(engine.siteUrl).hostname;
    return `https://icons.duckduckgo.com/ip3/${domain}.ico`;
  } catch {
    return "";
  }
}

function Clock() {
  const [time, setTime] = React.useState(new Date());

  React.useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const formattedTime = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const formattedDate = time.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase();

  return (
    <div className="text-center space-y-2">
      <h1 className="text-6xl md:text-8xl font-bold tracking-tighter text-foreground">
        {formattedTime}
      </h1>
      <p className="text-sm md:text-base font-medium text-muted-foreground tracking-widest">
        {formattedDate}
      </p>
    </div>
  );
}

export function HeroSection() {
  const allEngines = useSettingsStore(s => s.searchEngines);
  const searchEngines = React.useMemo(() => allEngines.filter(e => e.enabled), [allEngines]);
  
  const [query, setQuery] = React.useState("");
  const [engine, setEngine] = React.useState(searchEngines[0] || allEngines[0]);
  const [bookmarkResults, setBookmarkResults] = React.useState<SearchBookmark[]>([]);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const openTabs = useTabsStore(s => s.openTabs);
  const accessToken = useAuthStore(s => s.accessToken);
  const serverUrl = useAuthStore(s => s.serverUrl);

  // Focus search input when global shortcut fires on newtab page
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
        setBookmarkResults(res.bookmarks);
      } catch {
        setBookmarkResults([]);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, accessToken, serverUrl]);

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

  const handleSelect = React.useCallback((index: number) => {
    if (index < bookmarkResults.length) {
      const url = bookmarkResults[index].url;
      const existingTab = openTabs.find(t => t.url === url);
      if (existingTab) {
        chrome.tabs.update(existingTab.id, { active: true });
        chrome.windows.update(existingTab.windowId, { focused: true });
      } else {
        window.location.href = url;
      }
    } else if (index < bookmarkResults.length + filteredTabs.length) {
      const tab = filteredTabs[index - bookmarkResults.length];
      chrome.tabs.update(tab.id, { active: true });
      chrome.windows.update(tab.windowId, { focused: true });
    } else {
      window.location.href = engine.url.replace("%s", encodeURIComponent(query.trim()));
    }
    setQuery("");
  }, [bookmarkResults, filteredTabs, openTabs, engine, query]);

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
    if (query.trim()) {
      window.location.href = engine.url.replace("%s", encodeURIComponent(query.trim()));
      setQuery("");
    }
  };

  const isActive = (idx: number) => idx === activeIndex;
  const engineIndex = bookmarkResults.length + filteredTabs.length;

  return (
    <div className="flex flex-col items-center justify-center pt-8 md:pt-12 pb-2 md:pb-4 space-y-6 md:space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
      <Clock />

      <div ref={wrapperRef} className="w-full max-w-3xl px-4 relative">
        <form onSubmit={handleSearch} className="relative flex items-center w-full group">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="absolute left-1 z-10 size-12 rounded-full hover:bg-muted focus-visible:ring-0"
                type="button"
              >
                <img src={getEngineIconSrc(engine)} alt={engine.name} className="size-5 rounded-sm" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[150px] max-h-[300px] overflow-y-auto">
              {searchEngines.map((e) => (
                <DropdownMenuItem key={e.id} onClick={() => setEngine(e)} className="cursor-pointer">
                  <img src={getEngineIconSrc(e)} alt={e.name} className="size-4 mr-2 rounded-sm" />
                  {e.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <Input
            ref={inputRef}
            type="text"
            name="q"
            autoComplete="off"
            placeholder={`Search your bookmarks, tabs or with ${engine.name}...`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full h-14 pl-14 pr-14 rounded-full bg-background/60 backdrop-blur-md border-muted/60 shadow-sm text-lg focus-visible:ring-1 focus-visible:ring-primary/50 transition-all"
          />

          <Button
            type="submit"
            variant="ghost"
            size="icon"
            className="absolute right-1 z-10 size-12 rounded-full text-muted-foreground hover:text-foreground focus-visible:ring-0"
          >
            <Search className="size-5" />
          </Button>
        </form>

        {/* Search results dropdown */}
        {showDropdown && (
          <div
            className="absolute top-full left-4 right-4 mt-3 z-50 rounded-2xl border border-muted-foreground/30 dark:border-zinc-700/80 bg-background/95 dark:bg-zinc-950/95 backdrop-blur-xl shadow-[0_20px_50px_rgba(0,0,0,0.25),0_0_30px_rgba(0,0,0,0.05)] dark:shadow-[0_30px_70px_rgba(0,0,0,0.95),0_0_35px_rgba(99,102,241,0.18),0_0_55px_rgba(168,85,247,0.12)] p-1.5 ring-1 ring-black/10 dark:ring-white/15 overflow-hidden flex flex-col"
            onWheel={(e) => e.stopPropagation()}
          >
            <div
              className="overflow-y-auto max-h-96 w-full flex flex-col gap-1 pr-1.5 transition-all"
            >
              {bookmarkResults.length > 0 && (
                <section className="flex flex-col gap-1">
                  <div className="px-3 py-2 text-[10px] font-bold text-muted-foreground/75 uppercase tracking-widest flex items-center gap-1.5 border-b border-muted/20 bg-muted/5 rounded-t-xl">
                    <BookmarkIcon className="size-3 text-primary/80" />
                    Bookmarks ({bookmarkResults.length})
                  </div>
                  <div className="px-1.5 py-1 flex flex-col gap-1">
                    {bookmarkResults.map((bm, i) => (
                      <button
                        key={bm.id}
                        type="button"
                        className={cn(
                          "w-full flex items-start gap-3 px-3 py-2 rounded-xl text-left transition-all duration-200 border border-transparent cursor-pointer",
                          isActive(i)
                            ? "bg-primary/5 border-primary/10 dark:bg-primary/10 font-medium"
                            : "hover:bg-muted/40 hover:border-muted/30",
                        )}
                        onMouseEnter={() => setActiveIndex(i)}
                        onClick={() => handleSelect(i)}
                      >
                        <div className="size-6 rounded-md bg-background/85 shadow-xs border border-muted/40 flex items-center justify-center shrink-0 mt-0.5">
                          <FaviconImage
                            src={(() => { try { return `https://www.google.com/s2/favicons?domain=${new URL(bm.url).hostname}&sz=16`; } catch { return ""; } })()}
                            className="size-3.5"
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm font-medium truncate text-foreground">{bm.title}</span>
                            {bm.isArchived && (
                              <span className="shrink-0 flex items-center gap-0.5 text-[9px] px-1 py-px rounded border border-muted/50 bg-muted/30 text-muted-foreground font-semibold">
                                <Archive className="size-2.5" />
                                Archived
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground/60 truncate mt-0.5">{bm.url}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {filteredTabs.length > 0 && (
                <section className="flex flex-col gap-1">
                  <div className="px-3 py-2 text-[10px] font-bold text-muted-foreground/75 uppercase tracking-widest flex items-center gap-1.5 border-b border-muted/20 bg-muted/5 rounded-t-xl">
                    <Globe className="size-3 text-primary/80" />
                    Open Tabs ({filteredTabs.length})
                  </div>
                  <div className="px-1.5 py-1 flex flex-col gap-1">
                    {filteredTabs.map((tab, i) => {
                      const flatIdx = bookmarkResults.length + i;
                      return (
                        <button
                          key={tab.id}
                          type="button"
                          className={cn(
                            "w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-all duration-200 border border-transparent cursor-pointer",
                            isActive(flatIdx)
                              ? "bg-primary/5 border-primary/10 dark:bg-primary/10 font-medium"
                              : "hover:bg-muted/40 hover:border-muted/30",
                          )}
                          onMouseEnter={() => setActiveIndex(flatIdx)}
                          onClick={() => handleSelect(flatIdx)}
                        >
                          <div className="size-6 rounded-md bg-background/85 shadow-xs border border-muted/40 flex items-center justify-center shrink-0">
                            <FaviconImage src={tab.favIconUrl} className="size-3.5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium truncate text-foreground">{tab.title}</div>
                            <div className="text-xs text-muted-foreground/60 truncate mt-0.5">{tab.url}</div>
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
                    "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all duration-200 border border-transparent cursor-pointer",
                    isActive(engineIndex)
                      ? "bg-primary/5 border-primary/10 dark:bg-primary/10 font-medium"
                      : "hover:bg-muted/40 hover:border-muted/30",
                  )}
                  onMouseEnter={() => setActiveIndex(engineIndex)}
                  onClick={() => handleSelect(engineIndex)}
                >
                  <div className="size-6 rounded-md bg-background/85 shadow-xs border border-muted/40 flex items-center justify-center shrink-0">
                    <img src={getEngineIconSrc(engine)} alt={engine.name} className="size-3.5 rounded-xs" />
                  </div>
                  <span className="text-sm text-foreground">
                    Search <span className="font-semibold text-primary">"{query}"</span> with {engine.name}
                  </span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <AdBanner />
    </div>
  );
}
