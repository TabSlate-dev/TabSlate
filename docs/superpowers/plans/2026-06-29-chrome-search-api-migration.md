# Chrome Search API Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace TabSlate's custom search-engine picker with `chrome.search.query()` to comply with the Chrome Web Store Single Purpose policy (violation: overriding both the new tab page and the search experience).

**Architecture:** Every web-search dispatch currently builds a URL string with the user-selected engine and navigates to it. After this migration those dispatches call `chrome.search.query()`, which delegates to the browser's user-configured default engine. Content scripts cannot call `chrome.search` directly (restricted API), so `SearchOverlay` sends a new `WEB_SEARCH` background message that proxies the call. Bookmark search and tab search are untouched. The entire search-engine configuration UI (settings tab, store state, icon assets, server sync) is deleted.

**Tech Stack:** TypeScript, React, WXT (Chrome MV3), `chrome.search` API (Chrome 87+)

## Global Constraints

- MV3 only — `chrome.search.query({ text, disposition })` where `disposition` is `"CURRENT_TAB" | "NEW_TAB" | "NEW_WINDOW"`
- Content scripts cannot call `chrome.search` — must proxy via background `WEB_SEARCH` message
- Bookmark search and tab search remain fully intact
- i18n must be updated in both `public/_locales/en/messages.json` and `public/_locales/zh_CN/messages.json`
- `search_searchWith` i18n key is renamed to `search_searchWeb` (different parameter count); update every reference
- Do **not** touch `TabSlate-server` — the backend harmlessly retains `search_engines` in preferences
- `public/search-engine-icon/` must be removed from both disk and `wxt.config.ts` `web_accessible_resources`

---

### Task 1: Permission + WEB_SEARCH message type

**Files:**
- Modify: `wxt.config.ts`
- Modify: `lib/messages.ts`

**Interfaces:**
- Produces: `"search"` in manifest permissions; `WEB_SEARCH` message type available across the codebase

- [ ] **Step 1: Add `"search"` permission in `wxt.config.ts`**

Change line:
```ts
permissions: ["tabs", "tabGroups", "storage", "contextMenus", "scripting"],
```
to:
```ts
permissions: ["tabs", "tabGroups", "storage", "contextMenus", "scripting", "search"],
```

- [ ] **Step 2: Remove `search-engine-icon/*` from `web_accessible_resources` in `wxt.config.ts`**

Change:
```ts
web_accessible_resources: [
  { resources: ["search-engine-icon/*"], matches: ["<all_urls>"] },
  { resources: ["newtab.html"], matches: ["*://*.tabslate.com/*", "http://localhost:*/*"] },
  { resources: ["content-scripts/content.css"], use_dynamic_url: true, matches: ["<all_urls>"] },
],
```
to:
```ts
web_accessible_resources: [
  { resources: ["newtab.html"], matches: ["*://*.tabslate.com/*", "http://localhost:*/*"] },
  { resources: ["content-scripts/content.css"], use_dynamic_url: true, matches: ["<all_urls>"] },
],
```

- [ ] **Step 3: Add `WEB_SEARCH` to `lib/messages.ts`**

```ts
export type ExtensionMessage =
  | { type: "ADD_BOOKMARK"; data: Omit<Bookmark, "id" | "createdAt" | "isFavorite"> }
  | { type: "BOOKMARKS_CHANGED" }
  | { type: "WORKSPACE_CHANGED" }
  | { type: "TABS_CHANGED" }
  | { type: "OPEN_SEARCH" }
  | { type: "GET_OPEN_TABS" }
  | { type: "FOCUS_TAB"; tabId: number; windowId: number }
  | { type: "OPEN_TAB"; url: string }
  | { type: "SEARCH_BOOKMARKS"; query: string }
  | { type: "WEB_SEARCH"; query: string };
```

- [ ] **Step 4: Build check**

```bash
cd /Users/lieutenant/Documents/github/TabSlate && npx wxt build 2>&1 | tail -10
```

Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add wxt.config.ts lib/messages.ts
git commit -m "feat: add chrome.search permission and WEB_SEARCH message type"
```

---

### Task 2: Background — handle WEB_SEARCH

**Files:**
- Modify: `entrypoints/background.ts`

**Interfaces:**
- Consumes: `WEB_SEARCH` type from Task 1
- Produces: background handler that calls `chrome.search.query({ text, disposition: "NEW_TAB" })`

- [ ] **Step 1: Add `WEB_SEARCH` handler in `entrypoints/background.ts`**

Inside the `chrome.runtime.onMessage.addListener(...)` callback, after the `SEARCH_BOOKMARKS` block (before the closing `}`), add:

```ts
if (message.type === "WEB_SEARCH") {
  chrome.search.query({ text: message.query, disposition: "NEW_TAB" });
  sendResponse({ ok: true });
  return true;
}
```

- [ ] **Step 2: Build check**

```bash
cd /Users/lieutenant/Documents/github/TabSlate && npx wxt build 2>&1 | tail -10
```

- [ ] **Step 3: Commit**

```bash
git add entrypoints/background.ts
git commit -m "feat: proxy WEB_SEARCH from content script through background"
```

---

### Task 3: Update `search-box.tsx` (new tab page hero search)

**Files:**
- Modify: `components/dashboard/search-box.tsx`

**Interfaces:**
- Consumes: `chrome.search.query` (available directly in newtab extension page)
- Produces: search box without engine dropdown; web search uses `chrome.search.query({ ..., disposition: "CURRENT_TAB" })`

- [ ] **Step 1: Replace `components/dashboard/search-box.tsx`**

```tsx
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
      setQuery("");
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
      setQuery("");
    } else {
      searchWeb();
    }
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

  const placeholder = collectionId !== undefined
    ? t("search_placeholderCollection")
    : t("search_placeholderGlobal");

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
```

- [ ] **Step 2: TypeScript check**

```bash
cd /Users/lieutenant/Documents/github/TabSlate && npx tsc --noEmit 2>&1 | head -20
```

Expected: no new errors referencing `search-box.tsx`.

- [ ] **Step 3: Commit**

```bash
git add components/dashboard/search-box.tsx
git commit -m "feat: replace engine dropdown in search-box with chrome.search.query"
```

---

### Task 4: Update `search-overlay.tsx` (content script)

**Files:**
- Modify: `components/search/search-overlay.tsx`

**Interfaces:**
- Consumes: `WEB_SEARCH` background handler from Task 2
- Produces: overlay without any engine state; web search via `chrome.runtime.sendMessage({ type: "WEB_SEARCH", query })`

Note: `chrome.search` is not accessible from content scripts — the background proxy added in Task 2 is required here.

- [ ] **Step 1: Replace `components/search/search-overlay.tsx`**

```tsx
import * as React from "react";
import { Search, Archive, BookmarkIcon, Globe, X } from "lucide-react";
import { FaviconImage } from "@/components/ui/favicon-image";
import type { SearchBookmark } from "@/lib/api";
import type { BrowserTab } from "@/lib/chrome/tabs";
import { cn } from "@/lib/utils";

interface Props {
  onClose: () => void;
}

export function SearchOverlay({ onClose }: Props) {
  const [query, setQuery] = React.useState("");
  const [openTabs, setOpenTabs] = React.useState<BrowserTab[]>([]);
  const [bookmarkResults, setBookmarkResults] = React.useState<SearchBookmark[]>([]);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

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

  React.useEffect(() => {
    if (query.length < 2) {
      setBookmarkResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      chrome.runtime.sendMessage(
        { type: "SEARCH_BOOKMARKS", query },
        (response: { ok: boolean; bookmarks: SearchBookmark[] } | undefined) => {
          if (cancelled) { return; }
          setBookmarkResults(response?.ok ? response.bookmarks : []);
        },
      );
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query]);

  React.useEffect(() => { setActiveIndex(0); }, [bookmarkResults.length, filteredTabs.length]);

  const showDropdown = query.length >= 2;
  const webIndex = bookmarkResults.length + filteredTabs.length;
  const totalItems = webIndex + 1;

  const handleSelect = React.useCallback((index: number) => {
    if (index < bookmarkResults.length) {
      const url = bookmarkResults[index].url;
      const existingTab = openTabs.find(t => t.url === url);
      if (existingTab) {
        chrome.runtime.sendMessage({ type: "FOCUS_TAB", tabId: existingTab.id, windowId: existingTab.windowId });
      } else {
        chrome.runtime.sendMessage({ type: "OPEN_TAB", url });
      }
    } else if (index < bookmarkResults.length + filteredTabs.length) {
      const tab = filteredTabs[index - bookmarkResults.length];
      chrome.runtime.sendMessage({ type: "FOCUS_TAB", tabId: tab.id, windowId: tab.windowId });
    } else {
      chrome.runtime.sendMessage({ type: "WEB_SEARCH", query: query.trim() });
    }
    onClose();
  }, [bookmarkResults, filteredTabs, openTabs, query, onClose]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { onClose(); return; }
    if (!showDropdown) {
      if (e.key === "Enter" && query.trim() && !e.nativeEvent.isComposing) { handleSelect(webIndex); }
      return;
    }
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
    }
  };

  const isActive = (idx: number) => idx === activeIndex;

  return (
    <div
      className="fixed inset-0 z-[2147483647] flex items-start justify-center pt-[12vh] bg-black/50 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) { onClose(); } }}
    >
      <div className="w-full max-w-2xl mx-4 animate-in zoom-in-95 fade-in duration-150">
        <div className="relative flex items-center">
          <Search className="absolute left-4 size-5 text-muted-foreground pointer-events-none z-10" />
          <input
            ref={inputRef}
            type="text"
            autoComplete="off"
            placeholder="Search bookmarks, tabs, or the web…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className={cn(
              "w-full h-14 pl-12 pr-12 rounded-2xl text-lg outline-none",
              "bg-background text-foreground border border-border",
              "shadow-2xl placeholder:text-muted-foreground",
              "focus:ring-2 focus:ring-primary/40 transition-shadow",
              showDropdown ? "rounded-t-2xl rounded-b-none" : "rounded-2xl",
            )}
          />
          <button
            type="button"
            onClick={() => { if (query) { setQuery(""); inputRef.current?.focus(); } else { onClose(); } }}
            className="absolute right-3 size-8 flex items-center justify-center rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>

        {showDropdown && (
          <div className="rounded-b-2xl border border-t-0 border-border bg-popover shadow-2xl overflow-hidden">
            <div className="max-h-[55vh] overflow-y-auto">
              {bookmarkResults.length > 0 && (
                <section>
                  <div className="px-4 py-2 text-xs font-semibold text-muted-foreground flex items-center gap-1.5 bg-muted/40 border-b border-border">
                    <BookmarkIcon className="size-3" /> BOOKMARKS
                  </div>
                  <div className="px-2 py-1 flex flex-col gap-0.5">
                    {bookmarkResults.map((bm, i) => (
                      <button
                        key={bm.id} type="button"
                        className={cn("w-full flex items-start gap-3 px-3 py-2 rounded-xl text-left transition-colors", isActive(i) ? "bg-accent" : "hover:bg-accent/60")}
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
                  </div>
                </section>
              )}

              {filteredTabs.length > 0 && (
                <section>
                  <div className="px-4 py-2 text-xs font-semibold text-muted-foreground flex items-center gap-1.5 bg-muted/40 border-b border-border">
                    <Globe className="size-3" /> OPEN TABS
                  </div>
                  <div className="px-2 py-1 flex flex-col gap-0.5">
                    {filteredTabs.map((tab, i) => {
                      const flatIdx = bookmarkResults.length + i;
                      return (
                        <button
                          key={tab.id} type="button"
                          className={cn("w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-colors", isActive(flatIdx) ? "bg-accent" : "hover:bg-accent/60")}
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
                  </div>
                </section>
              )}

              <div className="border-t border-border px-2 py-1">
                <button
                  type="button"
                  className={cn("w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-colors", isActive(webIndex) ? "bg-accent" : "hover:bg-accent/60")}
                  onMouseEnter={() => setActiveIndex(webIndex)}
                  onClick={() => handleSelect(webIndex)}
                >
                  <Search className="size-4 shrink-0 text-muted-foreground" />
                  <span className="text-sm text-foreground">
                    Search <span className="font-semibold">"{query}"</span> on the web
                  </span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: TypeScript check**

```bash
cd /Users/lieutenant/Documents/github/TabSlate && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add components/search/search-overlay.tsx
git commit -m "feat: remove engine from search overlay, proxy web search via WEB_SEARCH"
```

---

### Task 5: Update `search-panel.tsx` (popup / search entrypoint)

**Files:**
- Modify: `components/search/search-panel.tsx`

**Interfaces:**
- Consumes: `chrome.search.query` (available directly in popup extension page)
- Produces: search panel without engine state; web search via `chrome.search.query({ ..., disposition: "NEW_TAB" })`

- [ ] **Step 1: Replace `components/search/search-panel.tsx`**

```tsx
import * as React from "react";
import { Search, Globe, BookmarkIcon, Archive } from "lucide-react";
import { Input } from "@/components/ui/input";
import { FaviconImage } from "@/components/ui/favicon-image";
import { useAuthStore } from "@/store/auth-store";
import { searchBookmarks } from "@/lib/api";
import type { SearchBookmark } from "@/lib/api";
import type { BrowserTab } from "@/lib/chrome/tabs";
import { smartOpenUrl } from "@/lib/chrome/tabs";
import { cn } from "@/lib/utils";

interface Props {
  openTabs: BrowserTab[];
  onClose?: () => void;
  autoFocus?: boolean;
  smartOpen?: boolean;
}

export function SearchPanel({ openTabs, onClose, autoFocus, smartOpen }: Props) {
  const [query, setQuery] = React.useState("");
  const [bookmarkResults, setBookmarkResults] = React.useState<SearchBookmark[]>([]);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const panelRef = React.useRef<HTMLDivElement>(null);

  const accessToken = useAuthStore(s => s.accessToken);
  const serverUrl = useAuthStore(s => s.serverUrl);

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
      chrome.search.query({ text: query.trim(), disposition: "NEW_TAB" });
      onClose?.();
    }
  }, [bookmarkResults, filteredTabs, query, openUrl, onClose]);

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
  const webIndex = bookmarkResults.length + filteredTabs.length;

  return (
    <div ref={panelRef} className="relative w-full max-w-xl">
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

      {showDropdown && (
        <div className="absolute top-full mt-1 left-0 right-0 z-50 rounded-lg border bg-popover shadow-lg overflow-hidden">
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
                  className={cn("w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-accent", isActive(i) && "bg-accent")}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => handleSelect(i)}
                >
                  <FaviconImage src={(() => { try { return `https://www.google.com/s2/favicons?domain=${new URL(bm.url).hostname}&sz=16`; } catch { return ""; } })()} className="size-4 mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 truncate">
                      <span className="text-sm font-medium truncate">{bm.title}</span>
                      {bm.isArchived && (
                        <span className="shrink-0 flex items-center gap-0.5 text-[10px] px-1 py-0.5 rounded border text-muted-foreground">
                          <Archive className="size-2.5" /> Archived
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">{bm.url}</div>
                    {bm.description && <div className="text-xs text-muted-foreground truncate mt-0.5">{bm.description}</div>}
                  </div>
                </button>
              ))}
            </section>
          )}

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
                    className={cn("w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-accent", isActive(flatIdx) && "bg-accent")}
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

          <button
            type="button"
            className={cn("w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-accent border-t", isActive(webIndex) && "bg-accent")}
            onMouseEnter={() => setActiveIndex(webIndex)}
            onClick={() => handleSelect(webIndex)}
          >
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <span className="text-sm">
              Search <span className="font-medium">"{query}"</span> on the web
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: TypeScript check**

```bash
cd /Users/lieutenant/Documents/github/TabSlate && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add components/search/search-panel.tsx
git commit -m "feat: remove engine from search panel, use chrome.search.query for web search"
```

---

### Task 6: Remove search engine state, settings tab, i18n keys, and icon assets

**Files:**
- Modify: `store/settings-store.ts`
- Modify: `components/dashboard/settings-dialog.tsx`
- Modify: `entrypoints/newtab/App.tsx`
- Modify: `public/_locales/en/messages.json`
- Modify: `public/_locales/zh_CN/messages.json`
- Delete: `public/search-engine-icon/` (6 SVG files)

**Interfaces:**
- Produces: settings store with only `_hydrated` + lifecycle methods; settings dialog with 3 tabs (General, Plan, Account); i18n without engine-picker strings

- [ ] **Step 1: Replace `store/settings-store.ts`**

```ts
import { create } from "zustand";

interface SettingsState {
  _hydrated: boolean;
  hydrate: () => Promise<void>;
  reset: () => void;
  pullFromServer: (serverUrl: string, accessToken: string) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  _hydrated: false,
  hydrate: async () => { set({ _hydrated: true }); },
  reset: () => { set({ _hydrated: true }); },
  pullFromServer: async () => { /* no user preferences to pull currently */ },
}));
```

- [ ] **Step 2: Remove `searchEngines` sync from `entrypoints/newtab/App.tsx` (StoreGate)**

In the `StoreGate` function, remove the `searchEngines` selector:
```ts
// DELETE this line:
const searchEngines = useSettingsStore((s) => s.searchEngines);
```

And remove the entire effect:
```ts
// DELETE this entire useEffect:
useEffect(() => {
  chrome.storage.local.set({ "tabslate-search-engines": JSON.stringify(searchEngines) });
}, [searchEngines]);
```

- [ ] **Step 3: Remove the "engines" tab from `components/dashboard/settings-dialog.tsx`**

Delete `SortableSearchEngineItem` (the entire function, lines 18–84 in the current file).

Remove these imports (they are no longer referenced after `SortableSearchEngineItem` is gone):
- From `"@/store/settings-store"`: remove `SearchEngine` (keep `useSettingsStore` import intact but remove `SearchEngine` named import)
- From `"lucide-react"`: remove `GripVertical`, `Trash2`, `Plus`
- Remove entire import line for `@dnd-kit/core`: `DndContext`, `closestCenter`, `KeyboardSensor`, `PointerSensor`, `useSensor`, `useSensors`
- Remove entire import line for `@dnd-kit/sortable`: `SortableContext`, `sortableKeyboardCoordinates`, `verticalListSortingStrategy`, `useSortable`
- Remove entire import line for `@dnd-kit/utilities`: `CSS`

Remove these store bindings (inside `SettingsDialog`):
```ts
// DELETE:
const searchEngines = useSettingsStore(s => s.searchEngines);
const updateSearchEngines = useSettingsStore(s => s.updateSearchEngines);
```

Remove these functions (inside `SettingsDialog`):
```ts
// DELETE: sensors, handleDragEnd, handleToggle, handleDelete
```

Remove these state declarations:
```ts
// DELETE:
const [showForm, setShowForm] = React.useState(false);
const [newName, setNewName] = React.useState("");
const [newUrl, setNewUrl] = React.useState("");
```

Remove the `canAdd` computed value and `handleAdd` function.

Remove the `useEffect` that clears form fields on `!open`:
```ts
// DELETE:
React.useEffect(() => {
  if (!open) {
    setShowForm(false);
    setNewName("");
    setNewUrl("");
  }
}, [open]);
```

Update `initialTab` type and `activeTab` state type — remove `"engines"`:
```ts
// BEFORE:
interface SettingsDialogProps {
  initialTab?: "general" | "engines" | "plan" | "account";
}
// ...
const [activeTab, setActiveTab] = React.useState<"general" | "engines" | "plan" | "account">("general");

// AFTER:
interface SettingsDialogProps {
  initialTab?: "general" | "plan" | "account";
}
// ...
const [activeTab, setActiveTab] = React.useState<"general" | "plan" | "account">("general");
```

Remove the "Search Engines" tab button:
```tsx
// DELETE this entire button block:
<button
  onClick={() => setActiveTab("engines")}
  className={cn(...)}
>
  {t("settings_tabEngines")}
</button>
```

Remove the engines tab content block:
```tsx
// DELETE:
{activeTab === "engines" && (
  <div className="space-y-6 animate-in fade-in duration-200">
    ...entire block...
  </div>
)}
```

- [ ] **Step 4: Update `public/_locales/en/messages.json`**

Replace `search_placeholderGlobal` (remove `$1` parameter):
```json
"search_placeholderGlobal": {
  "message": "Search your bookmarks, tabs, or the web..."
},
```

Rename `search_searchWith` → `search_searchWeb` (now takes only `$1` = query, not engine name):
```json
"search_searchWeb": {
  "message": "Search \"$1\" on the web"
},
```

Delete these keys entirely:
- `"search_searchWith"` (replaced by `search_searchWeb` above)
- `"settings_tabEngines"`
- `"settings_enginesTitle"`
- `"settings_enginesDesc"`
- `"settings_enginesPlaceholderName"`
- `"settings_enginesPlaceholderUrl"`
- `"settings_enginesUsePlaceholder"`

- [ ] **Step 5: Update `public/_locales/zh_CN/messages.json`**

Replace `search_placeholderGlobal`:
```json
"search_placeholderGlobal": {
  "message": "搜索书签、标签页或网页…"
},
```

Rename `search_searchWith` → `search_searchWeb`:
```json
"search_searchWeb": {
  "message": "在网页上搜索「$1」"
},
```

Delete the same 7 keys as Step 4.

- [ ] **Step 6: Delete icon asset directory**

```bash
rm -rf /Users/lieutenant/Documents/github/TabSlate/public/search-engine-icon
```

- [ ] **Step 7: Full build check**

```bash
cd /Users/lieutenant/Documents/github/TabSlate && npx tsc --noEmit 2>&1 | head -30 && npx wxt build 2>&1 | tail -10
```

Expected: no TypeScript errors; build succeeds.

- [ ] **Step 8: Commit**

```bash
git add store/settings-store.ts components/dashboard/settings-dialog.tsx entrypoints/newtab/App.tsx public/_locales/en/messages.json public/_locales/zh_CN/messages.json
git rm -r public/search-engine-icon
git commit -m "feat: remove search engine store, settings tab, i18n strings, and icon assets"
```

---

## Self-Review

**Spec coverage:**
- ✅ `"search"` permission added — Task 1
- ✅ `search-engine-icon/*` removed from `web_accessible_resources` — Task 1
- ✅ `WEB_SEARCH` message type added — Task 1
- ✅ Background proxies `chrome.search.query()` for content scripts — Task 2
- ✅ `SearchBox` (HeroSection/newtab) uses `chrome.search.query` — Task 3
- ✅ `SearchOverlay` (content script) uses `WEB_SEARCH` background proxy — Task 4
- ✅ `SearchPanel` (popup) uses `chrome.search.query` — Task 5
- ✅ Engine dropdown removed from `SearchBox` — Task 3
- ✅ Engine state removed from `SearchOverlay` — Task 4
- ✅ Engine state removed from `SearchPanel` — Task 5
- ✅ Settings "engines" tab removed from `SettingsDialog` — Task 6
- ✅ `settings-store.ts` purged of all `SearchEngine` state — Task 6
- ✅ StoreGate no longer syncs engines to `chrome.storage.local` — Task 6
- ✅ i18n updated in both locales — Task 6
- ✅ `public/search-engine-icon/` deleted — Task 6
- ✅ Server untouched — no task (intentional)

**Placeholder scan:** All code blocks are complete. No TBDs.

**Type consistency:**
- `webIndex` is used uniformly in Tasks 3, 4, 5 (replaces `engineIndex`)
- `WEB_SEARCH` message spelling is consistent across Tasks 1, 2, 4
- `search_searchWeb` i18n key is introduced in Task 6 Step 4/5 and consumed in Task 3 Step 1 — execution order must be Task 3 after Task 6, OR the implementer treats i18n as a separate pass; both work since missing i18n keys fall back to the key name itself at runtime
