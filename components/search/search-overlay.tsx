import * as React from "react";
import { Search, Archive, BookmarkIcon, Globe, X } from "lucide-react";
import { FaviconImage } from "@/components/ui/favicon-image";
import type { SearchBookmark } from "@/lib/api";
import type { BrowserTab } from "@/lib/chrome/tabs";
import { cn } from "@/lib/utils";

const SEARCH_ENGINES = [
  { id: "google", name: "Google", url: "https://www.google.com/search?q=%s" },
  { id: "bing",   name: "Bing",   url: "https://www.bing.com/search?q=%s" },
  { id: "duckduckgo", name: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s" },
];

interface Props {
  onClose: () => void;
}

export function SearchOverlay({ onClose }: Props) {
  const [query, setQuery] = React.useState("");
  const [openTabs, setOpenTabs] = React.useState<BrowserTab[]>([]);
  const [bookmarkResults, setBookmarkResults] = React.useState<SearchBookmark[]>([]);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [engine] = React.useState(SEARCH_ENGINES[0]);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Read auth from chrome.storage.local directly — Zustand's async persist
  // rehydration is unreliable in content script context (separate JS context).
  const [accessToken, setAccessToken] = React.useState<string | null>(null);
  const [serverUrl, setServerUrl] = React.useState<string>(
    (import.meta.env.VITE_API_URL as string | undefined) ?? "",
  );

  React.useEffect(() => {
    chrome.storage.local.get("tabslate-auth", (result) => {
      // chromeStorageAdapter stores via JSON.stringify, so value is a string
      const raw = result["tabslate-auth"];
      if (typeof raw !== "string") { return; }
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parsed = JSON.parse(raw) as any;
        const state = parsed?.state;
        if (state?.accessToken) {
          setAccessToken(state.accessToken as string);
          if (state.serverUrl) { setServerUrl(state.serverUrl as string); }
        }
      } catch { /* ignore malformed data */ }
    });
  }, []);

  // Fetch open tabs via background proxy (content scripts can't call chrome.tabs.query directly)
  React.useEffect(() => {
    chrome.runtime.sendMessage({ type: "GET_OPEN_TABS" }, (tabs: BrowserTab[]) => {
      if (tabs) { setOpenTabs(tabs); }
    });
  }, []);



  const filteredTabs = React.useMemo(() => {
    if (query.length < 2) { return []; }
    const lower = query.toLowerCase();
    return openTabs.filter(
      t => t.title.toLowerCase().includes(lower) || t.url.toLowerCase().includes(lower),
    );
  }, [openTabs, query]);

  // Debounced bookmark search — proxied through background to avoid CORS
  React.useEffect(() => {
    if (query.length < 2 || !accessToken) {
      setBookmarkResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      chrome.runtime.sendMessage(
        { type: "SEARCH_BOOKMARKS", query, accessToken, serverUrl },
        (response: { ok: boolean; bookmarks: SearchBookmark[] }) => {
          if (!cancelled && response?.ok) {
            setBookmarkResults(response.bookmarks);
          }
        },
      );
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, accessToken, serverUrl]);

  React.useEffect(() => { setActiveIndex(0); }, [bookmarkResults.length, filteredTabs.length]);

  const showDropdown = query.length >= 2;
  const engineIndex = bookmarkResults.length + filteredTabs.length;
  const totalItems = engineIndex + 1;

  const handleSelect = React.useCallback((index: number) => {
    if (index < bookmarkResults.length) {
      chrome.tabs.create({ url: bookmarkResults[index].url });
    } else if (index < bookmarkResults.length + filteredTabs.length) {
      const tab = filteredTabs[index - bookmarkResults.length];
      chrome.runtime.sendMessage({ type: "FOCUS_TAB", tabId: tab.id, windowId: tab.windowId });
    } else {
      chrome.tabs.create({ url: engine.url.replace("%s", encodeURIComponent(query.trim())) });
    }
    onClose();
  }, [bookmarkResults, filteredTabs, engine, query, onClose]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { onClose(); return; }
    if (!showDropdown) {
      if (e.key === "Enter" && query.trim()) { handleSelect(engineIndex); }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex(i => Math.min(i + 1, totalItems - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      handleSelect(activeIndex);
    }
  };

  const isActive = (idx: number) => idx === activeIndex;

  return (
    /* Full-screen backdrop */
    <div
      className="fixed inset-0 z-[2147483647] flex items-start justify-center pt-[12vh] bg-black/50 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) { onClose(); } }}
    >
      {/* Search card */}
      <div className="w-full max-w-2xl mx-4 animate-in zoom-in-95 fade-in duration-150">
        {/* Search input row */}
        <div className="relative flex items-center">
          <Search className="absolute left-4 size-5 text-muted-foreground pointer-events-none z-10" />
          <input
            ref={inputRef}
            type="text"
            autoComplete="off"
            placeholder="Search bookmarks, tabs, or Google…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className={cn(
              "w-full h-14 pl-12 pr-12 rounded-2xl text-lg outline-none",
              "bg-background text-foreground border border-border",
              "shadow-2xl placeholder:text-muted-foreground",
              "focus:ring-2 focus:ring-primary/40 transition-shadow",
              !showDropdown && "rounded-2xl",
              showDropdown && "rounded-t-2xl rounded-b-none",
            )}
          />
          <button
            type="button"
            onClick={onClose}
            className="absolute right-3 size-8 flex items-center justify-center rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Dropdown */}
        {showDropdown && (
          <div className="rounded-b-2xl border border-t-0 border-border bg-popover shadow-2xl overflow-hidden">
            <div className="max-h-[55vh] overflow-y-auto">
              {/* Bookmarks */}
              {bookmarkResults.length > 0 && (
                <section>
                  <div className="px-4 py-2 text-xs font-semibold text-muted-foreground flex items-center gap-1.5 bg-muted/40 border-b border-border">
                    <BookmarkIcon className="size-3" /> BOOKMARKS
                  </div>
                  {bookmarkResults.map((bm, i) => (
                    <button
                      key={bm.id} type="button"
                      className={cn("w-full flex items-start gap-3 px-4 py-2.5 text-left transition-colors", isActive(i) ? "bg-accent" : "hover:bg-accent/60")}
                      onMouseEnter={() => setActiveIndex(i)}
                      onClick={() => handleSelect(i)}
                    >
                      <FaviconImage
                        src={(() => { try { return `https://www.google.com/s2/favicons?domain=${new URL(bm.url).hostname}&sz=32`; } catch { return ""; } })()}
                        className="size-4 mt-0.5 shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-medium truncate text-foreground">{bm.title}</span>
                          {bm.isArchived && (
                            <span className="shrink-0 flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
                              <Archive className="size-2.5" /> Archived
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">{bm.url}</div>
                      </div>
                    </button>
                  ))}
                </section>
              )}

              {/* Open Tabs */}
              {filteredTabs.length > 0 && (
                <section>
                  <div className="px-4 py-2 text-xs font-semibold text-muted-foreground flex items-center gap-1.5 bg-muted/40 border-b border-border">
                    <Globe className="size-3" /> OPEN TABS
                  </div>
                  {filteredTabs.map((tab, i) => {
                    const flatIdx = bookmarkResults.length + i;
                    return (
                      <button
                        key={tab.id} type="button"
                        className={cn("w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors", isActive(flatIdx) ? "bg-accent" : "hover:bg-accent/60")}
                        onMouseEnter={() => setActiveIndex(flatIdx)}
                        onClick={() => handleSelect(flatIdx)}
                      >
                        <FaviconImage src={tab.favIconUrl} className="size-4 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium truncate text-foreground">{tab.title}</div>
                          <div className="text-xs text-muted-foreground truncate">{tab.url}</div>
                        </div>
                      </button>
                    );
                  })}
                </section>
              )}

              {/* Google fallback */}
              <button
                type="button"
                className={cn("w-full flex items-center gap-3 px-4 py-2.5 text-left border-t border-border transition-colors", isActive(engineIndex) ? "bg-accent" : "hover:bg-accent/60")}
                onMouseEnter={() => setActiveIndex(engineIndex)}
                onClick={() => handleSelect(engineIndex)}
              >
                <Search className="size-4 shrink-0 text-muted-foreground" />
                <span className="text-sm text-foreground">
                  Search <span className="font-semibold">"{query}"</span> on Google
                </span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
