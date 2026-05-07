# Tab Metadata & Unified Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture og:title and meta description when saving tabs, index bookmarks in MeiliSearch per-user, and surface a unified search UI (content-page inline + Ctrl+Shift+K popup) that searches bookmarks via MeiliSearch, open tabs locally, and falls back to Google.

**Architecture:** MeiliSearch runs in a Docker container accessible only from the Go backend; the frontend never speaks to it directly. Three save paths (tabs-store, popup, background context menu) call `GET_PAGE_INFO` before creating a bookmark to pull og:title and metaDescription. A shared `SearchPanel` React component is used both inline in `BookmarksContent` and in a standalone WXT entrypoint opened via keyboard shortcut.

**Tech Stack:** Go 1.25, `github.com/meilisearch/meilisearch-go`, TypeScript/React 19, Zustand, WXT, Tailwind + shadcn/ui

---

## File Map

### TabSlate-server (Go)

| Status | Path | Purpose |
|--------|------|---------|
| Create | `internal/search/types.go` | `BookmarkDoc` struct for MeiliSearch documents |
| Create | `internal/search/client.go` | MeiliSearch client wrapper — init, upsert, delete, search |
| Modify | `app/config.go` | Add `MeiliSearchHost`, `MeiliSearchAPIKey` fields |
| Modify | `app/server.go` | Create `search.Client`, wire into handlers and routes |
| Modify | `internal/handler/bookmarks.go` | Add `search *search.Client` field; fire hooks after Create/Update/Delete |
| Modify | `internal/handler/sync.go` | Add `search *search.Client` field; fire hooks after Push commit |
| Create | `internal/handler/search.go` | `SearchHandler` — `GET /search?q=` endpoint |
| Modify | `go.mod` / `go.sum` | Add meilisearch-go dependency |

### TabSlate (Frontend)

| Status | Path | Purpose |
|--------|------|---------|
| Modify | `entrypoints/content.ts` | Extract `ogTitle` and `metaDescription` in `GET_PAGE_INFO` response |
| Modify | `store/tabs-store.ts` | Call `GET_PAGE_INFO` before saving; use ogTitle/metaDescription |
| Modify | `entrypoints/popup/App.tsx` | Call `GET_PAGE_INFO` before saving; use ogTitle/metaDescription |
| Modify | `entrypoints/background.ts` | Use ogTitle/metaDescription from existing `GET_PAGE_INFO` call |
| Modify | `lib/api.ts` | Add `SearchBookmark` type and `searchBookmarks()` function |
| Create | `components/search/search-panel.tsx` | Shared search UI — input, grouped results, keyboard nav |
| Modify | `components/dashboard/content.tsx` | Add inline `SearchBar` above bookmark grid |
| Create | `entrypoints/search/index.html` | HTML shell for search popup entrypoint |
| Create | `entrypoints/search/main.tsx` | React root for search popup |
| Create | `entrypoints/search/App.tsx` | Hydration gate + `SearchPanel` wrapper for popup |
| Modify | `entrypoints/background.ts` | Handle `open-search` command → `chrome.windows.create` |
| Modify | `wxt.config.ts` | Add `commands.open-search` with Ctrl+Shift+K |

---

## Phase 1 — TabSlate-server: MeiliSearch Integration

### Task 1: Add meilisearch-go dependency

**Files:**
- Modify: `go.mod`, `go.sum`

- [ ] **Step 1: Install the package**

```bash
cd /path/to/TabSlate-server
go get github.com/meilisearch/meilisearch-go@latest
```

Expected output: line added to `go.mod` like `github.com/meilisearch/meilisearch-go v0.31.x`

- [ ] **Step 2: Verify build still compiles**

```bash
go build ./...
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add go.mod go.sum
git commit -m "chore: add meilisearch-go dependency"
```

---

### Task 2: Create search package — types and client

**Files:**
- Create: `internal/search/types.go`
- Create: `internal/search/client.go`

- [ ] **Step 1: Create `internal/search/types.go`**

```go
package search

// BookmarkDoc is a MeiliSearch document representing one bookmark.
type BookmarkDoc struct {
	ID           string `json:"id"`
	UserID       string `json:"userId"`
	Title        string `json:"title"`
	URL          string `json:"url"`
	Description  string `json:"description"`
	CollectionID string `json:"collectionId"`
	IsArchived   bool   `json:"isArchived"`
}
```

- [ ] **Step 2: Create `internal/search/client.go`**

```go
package search

import (
	"encoding/json"
	"fmt"
	"log"

	meilisearch "github.com/meilisearch/meilisearch-go"
)

const indexName = "bookmarks"

// Client wraps a MeiliSearch index. All methods are nil-safe —
// if the client is nil (search disabled), they are no-ops.
type Client struct {
	svc   meilisearch.ServiceManager
	index meilisearch.IndexManager
}

// New creates a Client. Returns nil when host is empty (search disabled).
func New(host, apiKey string) *Client {
	if host == "" {
		return nil
	}
	svc := meilisearch.New(host, meilisearch.WithAPIKey(apiKey))
	c := &Client{
		svc:   svc,
		index: svc.Index(indexName),
	}
	c.initIndex()
	return c
}

func (c *Client) initIndex() {
	if _, err := c.svc.CreateIndex(&meilisearch.IndexConfig{
		Uid:        indexName,
		PrimaryKey: "id",
	}); err != nil {
		log.Printf("[search] createIndex (may already exist): %v", err)
	}
	if _, err := c.index.UpdateSettings(&meilisearch.Settings{
		FilterableAttributes: []string{"userId"},
		SearchableAttributes: []string{"title", "url", "description"},
	}); err != nil {
		log.Printf("[search] updateSettings: %v", err)
	}
}

// UpsertBookmark adds or updates a document in the index. Fire-and-forget goroutine.
func (c *Client) UpsertBookmark(doc BookmarkDoc) {
	if c == nil {
		return
	}
	go func() {
		if _, err := c.index.AddDocuments([]BookmarkDoc{doc}, "id"); err != nil {
			log.Printf("[search] upsertBookmark %s: %v", doc.ID, err)
		}
	}()
}

// DeleteBookmark removes a document from the index. Fire-and-forget goroutine.
func (c *Client) DeleteBookmark(id string) {
	if c == nil {
		return
	}
	go func() {
		if _, err := c.index.DeleteDocument(id); err != nil {
			log.Printf("[search] deleteBookmark %s: %v", id, err)
		}
	}()
}

// SearchBookmarks queries the index filtered to a single user.
func (c *Client) SearchBookmarks(userID, query string) ([]BookmarkDoc, error) {
	if c == nil {
		return []BookmarkDoc{}, nil
	}
	res, err := c.index.Search(query, &meilisearch.SearchRequest{
		Filter:               fmt.Sprintf(`userId = "%s"`, userID),
		AttributesToRetrieve: []string{"id", "title", "url", "description", "collectionId", "isArchived"},
		Limit:                20,
	})
	if err != nil {
		return nil, fmt.Errorf("meilisearch search: %w", err)
	}
	raw, err := json.Marshal(res.Hits)
	if err != nil {
		return nil, fmt.Errorf("marshal hits: %w", err)
	}
	var docs []BookmarkDoc
	if err := json.Unmarshal(raw, &docs); err != nil {
		return nil, fmt.Errorf("unmarshal hits: %w", err)
	}
	return docs, nil
}
```

- [ ] **Step 3: Verify package compiles**

```bash
go build ./internal/search/...
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add internal/search/
git commit -m "feat(search): add MeiliSearch client package"
```

---

### Task 3: Add MeiliSearch config + wire into server

**Files:**
- Modify: `app/config.go`
- Modify: `app/server.go`

- [ ] **Step 1: Add config fields to `app/config.go`**

In `Config` struct, after the `OTPCaptchaWindow` field add:

```go
// ── MeiliSearch ──────────────────────────────────────────────────────────────
// MeiliSearchHost is the internal URL of the MeiliSearch instance,
// e.g. "http://meilisearch:7700". Leave empty to disable search indexing.
MeiliSearchHost   string

// MeiliSearchAPIKey is the master or admin API key for MeiliSearch.
MeiliSearchAPIKey string
```

In `LoadConfig()`, after the `OTPCaptchaWindow` line add:

```go
MeiliSearchHost:   os.Getenv("MEILISEARCH_HOST"),
MeiliSearchAPIKey: os.Getenv("MEILISEARCH_API_KEY"),
```

- [ ] **Step 2: Add search client to `app/server.go`**

Add import:
```go
"github.com/tabslate/server/internal/search"
```

Add field to `Server` struct after `mailer`:
```go
search  *search.Client
```

In `New()`, add after the mailer block (before `s := &Server{...}`):
```go
sc := search.New(cfg.MeiliSearchHost, cfg.MeiliSearchAPIKey)
if sc != nil {
    log.Println("meilisearch search indexing enabled")
} else {
    log.Println("meilisearch not configured — search indexing disabled")
}
```

Add `search: sc` to the `Server` literal initializer.

- [ ] **Step 3: Update `setupRoutes()` in `app/server.go`**

Change:
```go
bmH := handler.NewBookmarkHandler(s.db)
syncH := handler.NewSyncHandler(s.db)
```

To:
```go
bmH := handler.NewBookmarkHandler(s.db, s.search)
syncH := handler.NewSyncHandler(s.db, s.search)
searchH := handler.NewSearchHandler(s.search)
```

Inside the `api` group (protected routes), after the bookmark routes, add:
```go
api.GET("/search", searchH.Search)
```

- [ ] **Step 4: Verify build**

```bash
go build ./...
```

Expected: compile errors on `NewBookmarkHandler`, `NewSyncHandler`, `NewSearchHandler` — that's expected, we fix them in the next tasks.

- [ ] **Step 5: Commit after next two tasks complete** (defer commit to Task 5)

---

### Task 4: Add search hooks to BookmarkHandler

**Files:**
- Modify: `internal/handler/bookmarks.go`

- [ ] **Step 1: Add `search` field and update constructor**

Change:
```go
type BookmarkHandler struct{ db *db.DB }

func NewBookmarkHandler(d *db.DB) *BookmarkHandler { return &BookmarkHandler{db: d} }
```

To:
```go
type BookmarkHandler struct {
	db     *db.DB
	search *search.Client
}

func NewBookmarkHandler(d *db.DB, sc *search.Client) *BookmarkHandler {
	return &BookmarkHandler{db: d, search: sc}
}
```

Add import: `"github.com/tabslate/server/internal/search"`

- [ ] **Step 2: Add helper for nil-safe pointer deref (bottom of file)**

```go
func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
```

- [ ] **Step 3: Fire upsert after Create commit**

After `globalHub.Broadcast(userID, seq)` in the `Create` handler, add:

```go
h.search.UpsertBookmark(search.BookmarkDoc{
    ID:           id,
    UserID:       userID,
    Title:        req.Title,
    URL:          req.URL,
    Description:  req.Description,
    CollectionID: derefStr(req.CollectionID),
    IsArchived:   req.IsArchived,
})
```

- [ ] **Step 4: Fire upsert or delete after Update commit**

After `globalHub.Broadcast(userID, seq)` in the `Update` handler, add:

```go
if req.IsTrashed {
    h.search.DeleteBookmark(id)
} else {
    h.search.UpsertBookmark(search.BookmarkDoc{
        ID:           id,
        UserID:       userID,
        Title:        req.Title,
        URL:          req.URL,
        Description:  req.Description,
        CollectionID: derefStr(req.CollectionID),
        IsArchived:   req.IsArchived,
    })
}
```

- [ ] **Step 5: Fire delete after Delete commit**

After `globalHub.Broadcast(userID, seq)` in the `Delete` handler, add:

```go
h.search.DeleteBookmark(id)
```

- [ ] **Step 6: Verify build**

```bash
go build ./internal/handler/...
```

Expected: no errors (assuming Task 3 server.go changes compile correctly once `NewSearchHandler` exists).

---

### Task 5: Add search hooks to SyncHandler

**Files:**
- Modify: `internal/handler/sync.go`

- [ ] **Step 1: Add `search` field and update constructor**

Change:
```go
type SyncHandler struct{ db *db.DB }

func NewSyncHandler(d *db.DB) *SyncHandler { return &SyncHandler{db: d} }
```

To:
```go
type SyncHandler struct {
	db     *db.DB
	search *search.Client
}

func NewSyncHandler(d *db.DB, sc *search.Client) *SyncHandler {
	return &SyncHandler{db: d, search: sc}
}
```

Add import: `"github.com/tabslate/server/internal/search"`

- [ ] **Step 2: Collect search ops during the bookmark loop**

Before the `// ── Bookmarks ─────` loop, add:
```go
var searchUpserts []search.BookmarkDoc
var searchDeletes []string
```

After `if tag.RowsAffected() == 0 { rejected = ... }` inside the loop, add an `else` branch:
```go
} else {
    if bm.DeletedAt != nil || bm.IsTrashed {
        searchDeletes = append(searchDeletes, bm.ID)
    } else {
        searchUpserts = append(searchUpserts, search.BookmarkDoc{
            ID:           bm.ID,
            UserID:       userID,
            Title:        bm.Title,
            URL:          bm.URL,
            Description:  bm.Description,
            CollectionID: derefStr(bm.CollectionID),
            IsArchived:   bm.IsArchived,
        })
    }
}
```

Add `derefStr` import or use the one from bookmarks.go — since both are in `package handler`, the function is shared. No duplicate needed.

- [ ] **Step 3: Fire search ops after commit**

After `globalHub.Broadcast(userID, seq)` in the `Push` handler, add:

```go
for _, doc := range searchUpserts {
    h.search.UpsertBookmark(doc)
}
for _, id := range searchDeletes {
    h.search.DeleteBookmark(id)
}
```

- [ ] **Step 4: Verify build**

```bash
go build ./...
```

Expected: one remaining error — `NewSearchHandler` not yet defined. That's next.

---

### Task 6: Add GET /search endpoint

**Files:**
- Create: `internal/handler/search.go`

- [ ] **Step 1: Create `internal/handler/search.go`**

```go
package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/tabslate/server/internal/middleware"
	"github.com/tabslate/server/internal/search"
)

type SearchHandler struct {
	search *search.Client
}

func NewSearchHandler(sc *search.Client) *SearchHandler {
	return &SearchHandler{search: sc}
}

// GET /search?q=<query>
func (h *SearchHandler) Search(c *gin.Context) {
	q := c.Query("q")
	if len([]rune(q)) < 2 {
		c.JSON(http.StatusOK, gin.H{"bookmarks": []search.BookmarkDoc{}})
		return
	}

	userID := middleware.UserID(c)
	docs, err := h.search.SearchBookmarks(userID, q)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "search failed"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"bookmarks": docs})
}
```

- [ ] **Step 2: Verify full build**

```bash
go build ./...
go vet ./...
```

Expected: no errors.

- [ ] **Step 3: Smoke test with curl (requires a running MeiliSearch instance)**

```bash
# Start server
go run ./cmd/server

# In another terminal — search (replace TOKEN with a real JWT from login)
curl -H "Authorization: Bearer TOKEN" \
  "http://localhost:8080/search?q=test"
```

Expected: `{"bookmarks":[]}` (empty until bookmarks are indexed).

- [ ] **Step 4: Commit all Phase 1 changes**

```bash
git add app/config.go app/server.go \
        internal/handler/bookmarks.go \
        internal/handler/sync.go \
        internal/handler/search.go \
        internal/search/
git commit -m "feat(search): MeiliSearch indexing and search endpoint"
```

---

## Phase 2 — TabSlate: Metadata Capture at Save Time

### Task 7: Extend content.ts to extract og:title and metaDescription

**Files:**
- Modify: `entrypoints/content.ts`

- [ ] **Step 1: Update `GET_PAGE_INFO` response in `content.ts`**

Replace the entire file with:

```ts
export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type !== "GET_PAGE_INFO") { return false; }

      const faviconEl =
        document.querySelector<HTMLLinkElement>('link[rel="icon"]') ??
        document.querySelector<HTMLLinkElement>('link[rel="shortcut icon"]');
      const favicon = faviconEl?.href ?? `${location.origin}/favicon.ico`;

      const ogTitle =
        document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content ?? "";

      const metaDescription =
        document.querySelector<HTMLMetaElement>('meta[property="og:description"]')?.content ??
        document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ??
        "";

      sendResponse({
        title: document.title,
        url: location.href,
        selectedText: window.getSelection()?.toString()?.trim() ?? "",
        favicon,
        ogTitle,
        metaDescription,
      });

      return true;
    });
  },
});
```

- [ ] **Step 2: Build to verify TypeScript is valid**

```bash
bun run compile
```

Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add entrypoints/content.ts
git commit -m "feat(metadata): extract og:title and meta description in content script"
```

---

### Task 8: Use metadata in all three save paths

**Files:**
- Modify: `store/tabs-store.ts`
- Modify: `entrypoints/popup/App.tsx`
- Modify: `entrypoints/background.ts`

- [ ] **Step 1: Update `_saveTabsToCollectionHelper` in `store/tabs-store.ts`**

The helper currently maps `tab.title` to `title` and sets `description: ""`. Replace the bookmark-building block inside the `for (const tab of tabsToSave)` loop:

Change from:
```ts
newBookmarksData.push({
  id: generateId(),
  title: tab.title,
  url: tab.url,
  favicon: tab.favIconUrl,
  description: "",
  tags: [],
  createdAt: now,
  isFavorite: false,
  seq: 0,
});
```

To:

```ts
let title = tab.title;
let description = "";
try {
  const info = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_INFO" }) as {
    ogTitle?: string;
    metaDescription?: string;
  };
  if (info.ogTitle) { title = info.ogTitle; }
  description = info.metaDescription ?? "";
} catch {
  // Content script not injected (pdf, chrome:// page) — use tab defaults
}
newBookmarksData.push({
  id: generateId(),
  title,
  url: tab.url,
  favicon: tab.favIconUrl,
  description,
  tags: [],
  createdAt: now,
  isFavorite: false,
  seq: 0,
});
```

Note: `tab.id` is already typed as `number` in `BrowserTab`. The `for` loop must be changed from `for (const tab of tabsToSave)` to maintain the await, which it already does since the function is `async`.

- [ ] **Step 2: Update popup save path in `entrypoints/popup/App.tsx`**

In `handleSave`, the popup currently sets `description: note` (user-typed note). Keep `note` as-is — but also capture `ogTitle` to override the title if available.

Add a `pageInfo` state above `handleSave`:
```ts
const [pageInfo, setPageInfo] = useState<{ ogTitle: string; metaDescription: string } | null>(null);
```

In the existing `useEffect` that loads tab info, after `setTab({...})` add:
```ts
if (activeTab?.id) {
  chrome.tabs.sendMessage(activeTab.id, { type: "GET_PAGE_INFO" })
    .then((info: { ogTitle?: string; metaDescription?: string }) => {
      setPageInfo({ ogTitle: info.ogTitle ?? "", metaDescription: info.metaDescription ?? "" });
    })
    .catch(() => {});
}
```

In `handleSave`, change the `title` to use `ogTitle` if available:
```ts
const bookmarkData: BookmarkInput & { tags: string[]; seq: number } = {
  title: pageInfo?.ogTitle || tab.title,
  url: tab.url,
  favicon: tab.favIconUrl,
  description: note || pageInfo?.metaDescription || "",
  collectionId: selectedCollectionId,
  tags: [],
  seq: 0,
};
```

- [ ] **Step 3: Update background context menu save in `entrypoints/background.ts`**

The background already calls `GET_PAGE_INFO` and stores the result in `pageInfo`. Update the `bookmarkData` construction to use the new fields:

Change:
```ts
const bookmarkData = {
  title: pageInfo?.title ?? tab.title ?? "Untitled",
  url: info.linkUrl ?? pageInfo?.url ?? tab.url ?? "",
  favicon: pageInfo?.favicon ?? tab.favIconUrl ?? "",
  description: pageInfo?.selectedText ?? "",
  collectionId: "",
  tags: [] as string[],
  seq: 0,
};
```

To:
```ts
const bookmarkData = {
  title: pageInfo?.ogTitle || pageInfo?.title || tab.title || "Untitled",
  url: info.linkUrl ?? pageInfo?.url ?? tab.url ?? "",
  favicon: pageInfo?.favicon ?? tab.favIconUrl ?? "",
  description: pageInfo?.selectedText || pageInfo?.metaDescription || "",
  collectionId: "",
  tags: [] as string[],
  seq: 0,
};
```

- [ ] **Step 4: Build and type-check**

```bash
bun run compile
```

Expected: no errors.

- [ ] **Step 5: Manual test — save a tab via context menu**

Load the extension in dev mode (`bun run dev`), right-click on any web page and select "Save to TabSlate". Check that the saved bookmark's description is populated from the page's meta description (if the page has one).

- [ ] **Step 6: Commit**

```bash
git add entrypoints/content.ts store/tabs-store.ts entrypoints/popup/App.tsx entrypoints/background.ts
git commit -m "feat(metadata): use og:title and meta description when saving tabs"
```

---

## Phase 3 — TabSlate: Unified Search UI

### Task 9: Add searchBookmarks() to lib/api.ts

**Files:**
- Modify: `lib/api.ts`

- [ ] **Step 1: Add search types and function to `lib/api.ts`**

After the existing type definitions (e.g. after `SyncPullResponse`), add:

```ts
export interface SearchBookmark {
  id: string;
  title: string;
  url: string;
  description: string;
  collectionId: string;
  isArchived: boolean;
}

export interface SearchResponse {
  bookmarks: SearchBookmark[];
}
```

Add the function alongside the other API functions in the file:

```ts
export async function searchBookmarks(
  serverUrl: string,
  accessToken: string,
  query: string,
): Promise<SearchResponse> {
  const res = await fetch(
    `${serverUrl}/search?q=${encodeURIComponent(query)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    throw new ApiError(`search failed`, res.status);
  }
  return res.json() as Promise<SearchResponse>;
}
```

- [ ] **Step 2: Type-check**

```bash
bun run compile
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/api.ts
git commit -m "feat(search): add searchBookmarks API function"
```

---

### Task 10: Build the shared SearchPanel component

**Files:**
- Create: `components/search/search-panel.tsx`

- [ ] **Step 1: Create `components/search/search-panel.tsx`**

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
  /** When true, opening a URL reuses an existing tab via smartOpenUrl (content-page mode). */
  smartOpen?: boolean;
}

export function SearchPanel({ openTabs, onClose, autoFocus, smartOpen }: Props) {
  const [query, setQuery] = React.useState("");
  const [bookmarkResults, setBookmarkResults] = React.useState<SearchBookmark[]>([]);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
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

  // Auto-focus Google row when no results
  React.useEffect(() => {
    if (bookmarkResults.length === 0 && filteredTabs.length === 0) {
      setActiveIndex(0); // Google row is the only item in this case
    } else {
      setActiveIndex(0);
    }
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
        url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
      });
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

  // Flat index helpers
  const isActive = (idx: number) => idx === activeIndex;
  const googleIndex = bookmarkResults.length + filteredTabs.length;

  return (
    <div ref={panelRef} className="relative w-full max-w-xl">
      {/* Search input */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
        <Input
          ref={inputRef}
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
                  <FaviconImage src={`https://www.google.com/s2/favicons?domain=${new URL(bm.url).hostname}&sz=16`} className="size-4 mt-0.5 shrink-0" />
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
```

- [ ] **Step 2: Type-check**

```bash
bun run compile
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/search/search-panel.tsx
git commit -m "feat(search): add shared SearchPanel component"
```

---

### Task 11: Add inline search to BookmarksContent (4A)

**Files:**
- Modify: `components/dashboard/content.tsx`

- [ ] **Step 1: Add `SearchPanel` and store hooks at the top of `BookmarksContent`**

At the top of the `BookmarksContent` function body, add:

```tsx
const openTabs = useTabsStore(s => s.openTabs);
const loadTabs = useTabsStore(s => s.loadTabs);
const [searchOpen, setSearchOpen] = React.useState(false);

React.useEffect(() => {
  if (openTabs.length === 0) { loadTabs(true); }
}, []);
```

Add these imports at the top of the file:
```tsx
import { useTabsStore } from "@/store/tabs-store";
import { SearchPanel } from "@/components/search/search-panel";
```

- [ ] **Step 2: Add the inline search bar above the bookmark grid**

In the JSX returned by `BookmarksContent`, add the search bar as the very first child (before `<StatsCards>` or whatever the first element is):

```tsx
{/* Inline search */}
<div className="px-4 pt-4">
  <SearchPanel
    openTabs={openTabs}
    smartOpen
    onClose={() => setSearchOpen(false)}
  />
</div>
```

Note: `SearchPanel` manages its own open/close state internally for the dropdown; `setSearchOpen` is available if a parent-level open indicator is needed in future.

- [ ] **Step 3: Type-check and build**

```bash
bun run compile && bun run build
```

Expected: no errors.

- [ ] **Step 4: Dev smoke test**

```bash
bun run dev
```

Open a new tab in Chrome. Navigate to the `/` (bookmarks) route. Verify the search bar appears above the bookmark grid. Type 2+ characters and confirm the dropdown appears with sections.

- [ ] **Step 5: Commit**

```bash
git add components/dashboard/content.tsx
git commit -m "feat(search): add inline search bar to BookmarksContent"
```

---

### Task 12: Build the search popup entrypoint (4B)

**Files:**
- Create: `entrypoints/search/index.html`
- Create: `entrypoints/search/main.tsx`
- Create: `entrypoints/search/App.tsx`

- [ ] **Step 1: Create `entrypoints/search/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>TabSlate Search</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `entrypoints/search/App.tsx`**

```tsx
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { ThemeProvider } from "@/components/theme-provider";
import { SearchPanel } from "@/components/search/search-panel";
import { useAuthStore } from "@/store/auth-store";
import { useTabsStore } from "@/store/tabs-store";

export function SearchApp() {
  const authHydrated = useAuthStore(s => s._hydrated);
  const openTabs = useTabsStore(s => s.openTabs);
  const loadTabs = useTabsStore(s => s.loadTabs);
  const [tabsReady, setTabsReady] = useState(false);

  useEffect(() => {
    loadTabs(true).then(() => setTabsReady(true));
  }, [loadTabs]);

  if (!authHydrated || !tabsReady) {
    return (
      <div className="flex items-center justify-center w-full h-full">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <ThemeProvider>
      <div className="p-3 w-full">
        <SearchPanel
          openTabs={openTabs}
          autoFocus
          onClose={() => window.close()}
        />
      </div>
    </ThemeProvider>
  );
}
```

- [ ] **Step 3: Create `entrypoints/search/main.tsx`**

```tsx
import ReactDOM from "react-dom/client";
import { SearchApp } from "./App";
import "@/assets/tailwind.css";

ReactDOM.createRoot(document.getElementById("root")!).render(<SearchApp />);
```

Note: check the existing tailwind CSS import path used in `entrypoints/newtab/main.tsx` and use the same path here.

- [ ] **Step 4: Type-check**

```bash
bun run compile
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add entrypoints/search/
git commit -m "feat(search): add search popup entrypoint"
```

---

### Task 13: Register Ctrl+Shift+K command and open popup from background

**Files:**
- Modify: `wxt.config.ts`
- Modify: `entrypoints/background.ts`

- [ ] **Step 1: Add `commands` to `wxt.config.ts`**

Inside `manifest: { ... }`, add:

```ts
commands: {
  "open-search": {
    suggested_key: {
      default: "Ctrl+Shift+K",
      mac: "Command+Shift+K",
    },
    description: "Open TabSlate search",
  },
},
```

- [ ] **Step 2: Add command listener to `entrypoints/background.ts`**

At the end of `defineBackground(() => { ... })`, before the closing `}`, add:

```ts
// -------------------------------------------------------------------------
// Global search shortcut
// -------------------------------------------------------------------------
chrome.commands.onCommand.addListener((command) => {
  if (command !== "open-search") { return; }
  chrome.windows.create({
    url: chrome.runtime.getURL("search.html"),
    type: "popup",
    width: 640,
    height: 420,
    focused: true,
  });
});
```

- [ ] **Step 3: Build to verify**

```bash
bun run build
```

Expected: no errors. The build output should contain `search.html`.

- [ ] **Step 4: Dev smoke test — keyboard shortcut**

```bash
bun run dev
```

In Chrome, press `Ctrl+Shift+K` (or `Cmd+Shift+K` on Mac). A small popup window should open showing the search UI. Type 2+ characters and verify the dropdown works and the Google fallback is present. Press `Escape` — window should close.

- [ ] **Step 5: Commit**

```bash
git add wxt.config.ts entrypoints/background.ts
git commit -m "feat(search): register Ctrl+Shift+K shortcut and open search popup"
```

---

## Self-Review

### Spec Coverage Check

| Spec requirement | Covered by |
|---|---|
| og:title captured at save time | Task 7, Task 8 |
| meta description captured at save time | Task 7, Task 8 |
| og:title used for bookmark title if non-empty | Task 8 (all 3 save paths) |
| metaDescription populates Bookmark.description | Task 8 (all 3 save paths) |
| Graceful fallback when GET_PAGE_INFO fails | Task 8 (try/catch in each path) |
| MeiliSearch index with userId filter | Task 2 (client), Task 3 (config) |
| User isolation via backend-enforced userId filter | Task 6 (SearchHandler) |
| Bookmark upsert on create/update | Task 4 |
| Bookmark delete on trash/soft-delete | Task 4, Task 5 |
| Archived bookmarks remain in index (isArchived=true) | Task 4 (only IsTrashed triggers delete) |
| Sync push path also hooks MeiliSearch | Task 5 |
| GET /search?q= endpoint (min 2 chars) | Task 6 |
| searchBookmarks() in api.ts | Task 9 |
| SearchPanel shared component | Task 10 |
| Bookmarks section with Archived badge | Task 10 |
| Open tabs section (local filter) | Task 10 |
| Google fallback always visible, auto-focused when no results | Task 10 |
| Keyboard navigation (↑↓ Enter Escape) | Task 10 |
| smartOpenUrl for content-page mode | Task 10, Task 11 |
| Inline search in BookmarksContent | Task 11 |
| loadTabs() called if openTabs empty | Task 11 |
| Search popup entrypoint | Task 12 |
| Auth + tabs hydration before rendering popup | Task 12 |
| Ctrl+Shift+K opens popup window | Task 13 |
| popup window closes after selection | Task 10 (onClose → window.close()) |

### Notes for Implementer

- **TabSlate-Cloud**: After updating the `github.com/tabslate/server` dependency version in Cloud's `go.mod`, set `MEILISEARCH_HOST` and `MEILISEARCH_API_KEY` environment variables. No code changes needed.
- **Existing bookmarks**: Will not be in MeiliSearch until they are re-saved or until a backfill job is run. A backfill is out of scope for this plan.
- **Tailwind import path** in `entrypoints/search/main.tsx`: check the exact path used in `entrypoints/newtab/main.tsx` and mirror it.
- **MeiliSearch Docker** for local dev: `docker run -p 7700:7700 -e MEILI_MASTER_KEY=masterKey getmeili/meilisearch:latest`. Set `.env.local`: `MEILISEARCH_HOST=http://localhost:7700`, `MEILISEARCH_API_KEY=masterKey`.
