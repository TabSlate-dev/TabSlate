import * as React from "react";
import { Search, BookmarkIcon, Archive } from "lucide-react";
import { Input } from "@/components/ui/input";
import { FaviconImage } from "@/components/ui/favicon-image";
import { useAuthStore } from "@/store/auth-store";
import { searchBookmarks } from "@/lib/api";
import type { SearchBookmark } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Props {
  collectionId: string;
}

export function CollectionSearch({ collectionId }: Props) {
  const [query, setQuery] = React.useState("");
  const [bookmarkResults, setBookmarkResults] = React.useState<SearchBookmark[]>([]);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const accessToken = useAuthStore(s => s.accessToken);
  const serverUrl = useAuthStore(s => s.serverUrl);

  // Debounced search inside the selected collection
  React.useEffect(() => {
    if (query.length < 2 || !accessToken) {
      setBookmarkResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await searchBookmarks(serverUrl, accessToken, query);
        // Filter search results by the current collection ID
        const filtered = res.bookmarks.filter(bm => bm.collectionId === collectionId);
        setBookmarkResults(filtered);
      } catch {
        setBookmarkResults([]);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, accessToken, serverUrl, collectionId]);

  const showDropdown = query.length >= 2;
  const totalItems = bookmarkResults.length;

  React.useEffect(() => {
    setActiveIndex(0);
  }, [bookmarkResults.length]);

  // Click outside to close / reset search
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
    if (index >= 0 && index < bookmarkResults.length) {
      const url = bookmarkResults[index].url;
      // We open the URL in the current tab or standard extension link
      window.location.href = url;
    }
    setQuery("");
  }, [bookmarkResults]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showDropdown || totalItems === 0) { return; }
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
    if (totalItems > 0) {
      handleSelect(activeIndex);
    }
  };

  const isActive = (idx: number) => idx === activeIndex;

  return (
    <div ref={wrapperRef} className="w-full sm:w-72 md:w-80 relative z-20">
      <form onSubmit={handleSearch} className="relative flex items-center w-full group">
        <Search className="absolute left-3 size-4 text-muted-foreground group-hover:text-primary transition-colors pointer-events-none" />
        <Input
          ref={inputRef}
          type="text"
          name="q"
          autoComplete="off"
          placeholder="Search bookmarks in this collection..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          className="w-full h-10 pl-9 pr-9 rounded-full bg-background/60 backdrop-blur-md border-muted/60 shadow-sm text-sm focus-visible:ring-1 focus-visible:ring-primary/50 transition-all"
        />
      </form>

      {/* Search results dropdown */}
      {showDropdown && bookmarkResults.length > 0 && (
        <div
          className="absolute top-full left-0 right-0 mt-2 z-50 rounded-2xl border border-muted-foreground/30 dark:border-zinc-700/80 bg-background/95 dark:bg-zinc-950/95 backdrop-blur-xl shadow-[0_20px_50px_rgba(0,0,0,0.25),0_0_30px_rgba(0,0,0,0.05)] dark:shadow-[0_30px_70px_rgba(0,0,0,0.95),0_0_35px_rgba(99,102,241,0.18),0_0_55px_rgba(168,85,247,0.12)] p-1.5 ring-1 ring-black/10 dark:ring-white/15 overflow-hidden flex flex-col"
          onWheel={(e) => e.stopPropagation()}
        >
          <div className="overflow-y-auto max-h-80 w-full flex flex-col gap-1 pr-1.5 transition-all">
            <div className="px-1 py-0.5 flex flex-col gap-1">
              {bookmarkResults.map((bm, i) => (
                <button
                  key={bm.id}
                  type="button"
                  className={cn(
                    "w-full flex items-start gap-2.5 px-2.5 py-1.5 rounded-xl text-left transition-all duration-200 border border-transparent cursor-pointer",
                    isActive(i)
                      ? "bg-primary/5 border-primary/10 dark:bg-primary/10 font-medium"
                      : "hover:bg-muted/40 hover:border-muted/30",
                  )}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => handleSelect(i)}
                >
                  <div className="size-5 rounded-md bg-background/85 shadow-xs border border-muted/40 flex items-center justify-center shrink-0 mt-0.5">
                    <FaviconImage
                      src={(() => { try { return `https://www.google.com/s2/favicons?domain=${new URL(bm.url).hostname}&sz=16`; } catch { return ""; } })()}
                      className="size-3"
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium truncate text-foreground">{bm.title}</span>
                      {bm.isArchived && (
                        <span className="shrink-0 flex items-center gap-0.5 text-[8px] px-1 py-px rounded border border-muted/50 bg-muted/30 text-muted-foreground font-semibold">
                          <Archive className="size-2" />
                          Archived
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-muted-foreground/60 truncate mt-0.5">{bm.url}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
