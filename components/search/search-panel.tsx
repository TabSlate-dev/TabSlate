import * as React from "react";
import { Search, Globe, BookmarkIcon, Archive } from "lucide-react";
import { Input } from "@/components/ui/input";
import { FaviconImage } from "@/components/ui/favicon-image";
import { useAuthStore } from "@/store/auth-store";
import { useSettingsStore } from "@/store/settings-store";
import { searchBookmarks } from "@/lib/api";
import type { SearchBookmark } from "@/lib/api";
import type { BrowserTab } from "@/lib/chrome/tabs";
import { smartOpenUrl } from "@/lib/chrome/tabs";
import { cn } from "@/lib/utils";

interface Props {
  openTabs: BrowserTab[];
  onClose?: () => void;
  autoFocus?: boolean;
  /** When true, opening a URL reuses an existing tab via smartOpenUrl (content-page mode). */
  smartOpen?: boolean;
}

export function SearchPanel({ openTabs, onClose, autoFocus, smartOpen }: Props) {
  const [query, setQuery] = React.useState("");
  const [bookmarkResults, setBookmarkResults] = React.useState<SearchBookmark[]>([]);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const panelRef = React.useRef<HTMLDivElement>(null);

  const accessToken = useAuthStore(s => s.accessToken);
  const serverUrl = useAuthStore(s => s.serverUrl);
  const searchEngines = useSettingsStore(s => s.searchEngines);
  const defaultEngine = React.useMemo(
    () => searchEngines.find(e => e.enabled) ?? searchEngines[0],
    [searchEngines]
  );

  const filteredTabs = React.useMemo(() => {
    if (query.length < 2) { return []; }
    const lower = query.toLowerCase();
    return openTabs.filter(
      t => t.title.toLowerCase().includes(lower) || t.url.toLowerCase().includes(lower),
    );
  }, [openTabs, query]);

  const showDropdown = query.length >= 2;
  const totalItems = bookmarkResults.length + filteredTabs.length + 1;

  // Debounced bookmark search
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

  // Reset active index when results change
  React.useEffect(() => {
    setActiveIndex(0);
  }, [bookmarkResults.length, filteredTabs.length]);

  // Dismiss on outside click
  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose?.();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const openUrl = React.useCallback((url: string) => {
    if (smartOpen) {
      smartOpenUrl(url);
    } else {
      chrome.tabs.create({ url });
    }
    onClose?.();
  }, [smartOpen, onClose]);

  const handleSelect = React.useCallback((index: number) => {
    if (index < bookmarkResults.length) {
      openUrl(bookmarkResults[index].url);
    } else if (index < bookmarkResults.length + filteredTabs.length) {
      const tab = filteredTabs[index - bookmarkResults.length];
      chrome.tabs.update(tab.id, { active: true });
      chrome.windows.update(tab.windowId, { focused: true });
      onClose?.();
    } else {
      chrome.tabs.create({
        url: defaultEngine.url.replace("%s", encodeURIComponent(query.trim())),
      });
      onClose?.();
    }
  }, [bookmarkResults, filteredTabs, query, openUrl, onClose, defaultEngine]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showDropdown) { return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex(i => Math.min(i + 1, totalItems - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      handleSelect(activeIndex);
    } else if (e.key === "Escape") {
      onClose?.();
    }
  };

  const isActive = (idx: number) => idx === activeIndex;
  const googleIndex = bookmarkResults.length + filteredTabs.length;

  return (
    <div ref={panelRef} className="relative w-full max-w-xl">
      {/* Search input */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
        <Input
          autoFocus={autoFocus}
          placeholder="Search bookmarks, tabs…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          className="pl-9"
        />
      </div>

      {/* Dropdown */}
      {showDropdown && (
        <div className="absolute top-full mt-1 left-0 right-0 z-50 rounded-lg border bg-popover shadow-lg overflow-hidden">
          {/* Bookmarks section */}
          {bookmarkResults.length > 0 && (
            <section>
              <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground flex items-center gap-1.5 border-b">
                <BookmarkIcon className="size-3" />
                Bookmarks ({bookmarkResults.length})
              </div>
              {bookmarkResults.map((bm, i) => (
                <button
                  key={bm.id}
                  type="button"
                  className={cn(
                    "w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-accent",
                    isActive(i) && "bg-accent",
                  )}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => handleSelect(i)}
                >
                  <FaviconImage src={(() => { try { return `https://www.google.com/s2/favicons?domain=${new URL(bm.url).hostname}&sz=16`; } catch { return ""; } })()} className="size-4 mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 truncate">
                      <span className="text-sm font-medium truncate">{bm.title}</span>
                      {bm.isArchived && (
                        <span className="shrink-0 flex items-center gap-0.5 text-[10px] px-1 py-0.5 rounded border text-muted-foreground">
                          <Archive className="size-2.5" />
                          Archived
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">{bm.url}</div>
                    {bm.description && (
                      <div className="text-xs text-muted-foreground truncate mt-0.5">{bm.description}</div>
                    )}
                  </div>
                </button>
              ))}
            </section>
          )}

          {/* Open Tabs section */}
          {filteredTabs.length > 0 && (
            <section>
              <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground flex items-center gap-1.5 border-b">
                <Globe className="size-3" />
                Open Tabs ({filteredTabs.length})
              </div>
              {filteredTabs.map((tab, i) => {
                const flatIdx = bookmarkResults.length + i;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    className={cn(
                      "w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-accent",
                      isActive(flatIdx) && "bg-accent",
                    )}
                    onMouseEnter={() => setActiveIndex(flatIdx)}
                    onClick={() => handleSelect(flatIdx)}
                  >
                    <FaviconImage src={tab.favIconUrl} className="size-4 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{tab.title}</div>
                      <div className="text-xs text-muted-foreground truncate">{tab.url}</div>
                    </div>
                  </button>
                );
              })}
            </section>
          )}

          {/* Google fallback — always present */}
          <button
            type="button"
            className={cn(
              "w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-accent border-t",
              isActive(googleIndex) && "bg-accent",
            )}
            onMouseEnter={() => setActiveIndex(googleIndex)}
            onClick={() => handleSelect(googleIndex)}
          >
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <span className="text-sm">
              Search <span className="font-medium">"{query}"</span> on Google
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
