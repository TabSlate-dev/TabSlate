# OpenPanel Analytics Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add anonymous analytics to the TabSlate Chrome extension using a self-hosted OpenPanel instance, tracking lifecycle events, page views, feature usage, and sync errors.

**Architecture:** A single `lib/analytics.ts` module exposes `analytics.init()` and `analytics.track()`. All calls go directly to the OpenPanel `/api/track` REST endpoint via `fetch`. No SDK dependency. CORS is bypassed at the manifest level by injecting the OpenPanel origin into `host_permissions` at build time from `VITE_OPENPANEL_URL`.

**Tech Stack:** TypeScript, Chrome Extension MV3, `chrome.storage.local`, WXT manifest hooks, Vite env vars.

---

## File Map

| File | Action |
|---|---|
| `lib/analytics.ts` | **Create** — core analytics module |
| `wxt.config.ts` | **Modify** — inject OpenPanel origin into `host_permissions` |
| `.env.local` | **Modify** — add two env vars (not committed) |
| `entrypoints/background.ts` | **Modify** — `init()` on startup + lifecycle events |
| `entrypoints/newtab/App.tsx` | **Modify** — add `PageTracker` component for page_view |
| `store/bookmarks-store.ts` | **Modify** — `bookmark_added`, `bookmark_imported` |
| `store/workspace-store.ts` | **Modify** — `collection_created`, `workspace_created` |
| `store/groups-store.ts` | **Modify** — `group_saved` |
| `components/dashboard/search-box.tsx` | **Modify** — `search_used` |
| `lib/sync-engine.ts` | **Modify** — `sync_error` |

---

## Task 1: Create `lib/analytics.ts`

**Files:**
- Create: `lib/analytics.ts`

This is the foundation. All other tasks import from here.

- [ ] **Step 1: Create the file**

```typescript
// lib/analytics.ts
const OPENPANEL_URL = import.meta.env.VITE_OPENPANEL_URL as string | undefined;
const OPENPANEL_CLIENT_ID = import.meta.env.VITE_OPENPANEL_CLIENT_ID as string | undefined;

let sessionId: string | null = null;
let initPromise: Promise<void> | null = null;

async function init(): Promise<void> {
  if (sessionId) { return; }
  if (initPromise) { return initPromise; }
  initPromise = (async () => {
    const stored = await chrome.storage.local.get("tabslate-analytics-id");
    const existing = stored["tabslate-analytics-id"] as string | undefined;
    if (existing) {
      sessionId = existing;
    } else {
      sessionId = crypto.randomUUID();
      await chrome.storage.local.set({ "tabslate-analytics-id": sessionId });
    }
  })();
  return initPromise;
}

function track(name: string, properties?: Record<string, string | number | boolean>): void {
  if (!OPENPANEL_URL || !OPENPANEL_CLIENT_ID) { return; }
  void (async () => {
    if (!sessionId) { await init(); }
    try {
      await fetch(`${OPENPANEL_URL}/api/track`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "openpanel-client-id": OPENPANEL_CLIENT_ID!,
        },
        body: JSON.stringify({
          type: "track",
          payload: {
            name,
            profileId: sessionId,
            properties: properties ?? {},
          },
        }),
      });
    } catch { /* analytics must never crash the extension */ }
  })();
}

export const analytics = { init, track };
```

- [ ] **Step 2: Verify types compile**

```bash
cd /Users/lieutenant/Documents/github/TabSlate && bun run compile
```

Expected: no errors related to `lib/analytics.ts`.

- [ ] **Step 3: Commit**

```bash
git add lib/analytics.ts
git commit -m "feat: add analytics module for OpenPanel integration"
```

---

## Task 2: Inject OpenPanel origin into manifest

**Files:**
- Modify: `wxt.config.ts:35-38`

The `build:manifestGenerated` hook already deletes `host_permissions`. Extend it to add the OpenPanel origin so extension pages can `fetch` to it without CORS errors.

- [ ] **Step 1: Update `wxt.config.ts`**

Replace the existing hook body (lines 35-38):

```typescript
  hooks: {
    "build:manifestGenerated": (wxt, manifest) => {
      // Remove auto-generated host_permissions that conflict with optional_host_permissions
      delete manifest.host_permissions;

      // Inject OpenPanel origin so extension pages can fetch without CORS
      const openpanelUrl = process.env.VITE_OPENPANEL_URL;
      if (openpanelUrl) {
        try {
          const origin = new URL(openpanelUrl).origin + "/*";
          manifest.host_permissions = [origin];
        } catch { /* invalid URL, skip */ }
      }
    },
  },
```

- [ ] **Step 2: Add env vars to `.env.local`**

Open `.env.local` and append (replacing the placeholder values with your actual OpenPanel instance):

```bash
VITE_OPENPANEL_URL=https://your-openpanel.com
VITE_OPENPANEL_CLIENT_ID=your-client-id
```

> Note: `.env.local` is gitignored and must not be committed.

- [ ] **Step 3: Verify the build generates correct manifest**

```bash
bun run build
```

Then check `.output/chrome-mv3/manifest.json`. Expected: `"host_permissions": ["https://your-openpanel.com/*"]` appears.

- [ ] **Step 4: Commit**

```bash
git add wxt.config.ts
git commit -m "feat: inject OpenPanel origin into host_permissions at build time"
```

---

## Task 3: Lifecycle events in `background.ts`

**Files:**
- Modify: `entrypoints/background.ts:1-7` (imports), `entrypoints/background.ts:7` (top of defineBackground), `entrypoints/background.ts:45-51` (onInstalled listener)

- [ ] **Step 1: Add import at top of `background.ts`**

After the existing imports (after line 5), add:

```typescript
import { analytics } from "@/lib/analytics";
```

- [ ] **Step 2: Call `analytics.init()` at the start of `defineBackground`**

After line 7 (`export default defineBackground(() => {`), add before the `chrome.storage.session.setAccessLevel` call:

```typescript
  void analytics.init();
```

- [ ] **Step 3: Add lifecycle tracking to the `onInstalled` listener**

The existing `onInstalled` at lines 45-51 registers context menus. Add a new listener after it:

```typescript
  chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
    if (reason === "install") {
      analytics.track("extension_installed", {
        version: chrome.runtime.getManifest().version,
      });
    } else if (reason === "update") {
      analytics.track("extension_updated", {
        version: chrome.runtime.getManifest().version,
        previousVersion: previousVersion ?? "",
      });
    }
  });
```

- [ ] **Step 4: Verify build**

```bash
bun run compile
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add entrypoints/background.ts
git commit -m "feat(analytics): track extension lifecycle events"
```

---

## Task 4: Page view tracking in `newtab/App.tsx`

**Files:**
- Modify: `entrypoints/newtab/App.tsx`

`useLocation` must be called inside `<HashRouter>`. Add a `PageTracker` component that reads the current path and fires `page_view` on each route change.

- [ ] **Step 1: Add import for `analytics` and `useLocation`**

At the top of `App.tsx`, add after the existing react-router-dom import:

```typescript
import { useLocation } from "react-router-dom";
import { analytics } from "@/lib/analytics";
```

- [ ] **Step 2: Add `PageTracker` component**

Add this component definition above the `App` function (after the `AuthGate` function, before line 286):

```typescript
function PageTracker() {
  const location = useLocation();
  useEffect(() => {
    analytics.track("page_view", { path: location.pathname });
  }, [location.pathname]);
  return null;
}
```

- [ ] **Step 3: Mount `PageTracker` inside `HashRouter`**

Inside the `HashRouter` (line 316), add `<PageTracker />` as the first child, before `<TabsDndProvider>`:

```typescript
              <HashRouter>
                <PageTracker />
                <TabsDndProvider>
```

- [ ] **Step 4: Verify build**

```bash
bun run compile
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add entrypoints/newtab/App.tsx
git commit -m "feat(analytics): track page views on route change"
```

---

## Task 5: Feature events in `bookmarks-store.ts`

**Files:**
- Modify: `store/bookmarks-store.ts:1` (imports), `store/bookmarks-store.ts:280` (`addBookmark`), `store/bookmarks-store.ts:309` (`_bulkAddBookmarks`)

- [ ] **Step 1: Add import**

At the top of `bookmarks-store.ts`, add with the other imports:

```typescript
import { analytics } from "@/lib/analytics";
```

- [ ] **Step 2: Track `bookmark_added` in `addBookmark`**

In the `addBookmark` action (around line 293), after `usePlanStore.getState().incrementUsage("bookmark");`, add:

```typescript
          analytics.track("bookmark_added");
```

The full `addBookmark` body after the change:

```typescript
      addBookmark: (input) => {
        const fallback: Bookmark = { id: "", createdAt: "", isFavorite: false, ...input };
        return guardQuota("bookmark", undefined, fallback, () => {
          const bookmark: Bookmark = {
            id: generateId(),
            createdAt: new Date().toISOString(),
            isFavorite: false,
            ...input,
            favicon: normalizeFavicon(input.favicon, input.url),
          };
          set((s) => ({ bookmarks: [bookmark, ...s.bookmarks] }));
          idbPut("bookmarks", bookmark);
          syncEngine?.enqueue({ bookmarks: [toServerBookmark(bookmark)] });
          usePlanStore.getState().incrementUsage("bookmark");
          analytics.track("bookmark_added");
          return bookmark;
        });
      },
```

- [ ] **Step 3: Track `bookmark_imported` in `_bulkAddBookmarks`**

In `_bulkAddBookmarks` (around line 309), after `syncEngine?.enqueue(...)`, add:

```typescript
        analytics.track("bookmark_imported", { count: normalized.length });
```

The full `_bulkAddBookmarks` body after the change:

```typescript
      _bulkAddBookmarks: (newBookmarks) => {
        if (newBookmarks.length === 0) { return; }
        const normalized = newBookmarks.map((b) => ({ ...b, favicon: normalizeFavicon(b.favicon, b.url) }));
        set((s) => ({ bookmarks: [...normalized, ...s.bookmarks] }));
        for (const b of normalized) { idbPut("bookmarks", b); }
        syncEngine?.enqueue({ bookmarks: normalized.map(b => toServerBookmark(b)) });
        analytics.track("bookmark_imported", { count: normalized.length });
      },
```

- [ ] **Step 4: Verify build**

```bash
bun run compile
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add store/bookmarks-store.ts
git commit -m "feat(analytics): track bookmark_added and bookmark_imported events"
```

---

## Task 6: Feature events in `workspace-store.ts`

**Files:**
- Modify: `store/workspace-store.ts:1` (imports), `store/workspace-store.ts:403` (`createWorkspace`), `store/workspace-store.ts:501` (`createCollection`)

- [ ] **Step 1: Add import**

At the top of `workspace-store.ts`, add:

```typescript
import { analytics } from "@/lib/analytics";
```

- [ ] **Step 2: Track `workspace_created` in `createWorkspace`**

In `createWorkspace`, the `guardQuota` callback ends at (around lines 435-438):

```typescript
      syncEngine?.enqueue({ workspaces: [toServerWorkspace(ws)], collections: [toServerCollection(defaultCol)] });
      usePlanStore.getState().incrementUsage("workspace");
      usePlanStore.getState().incrementUsage("collection");
      return ws;
```

Add `analytics.track` after the two `incrementUsage` calls:

```typescript
      syncEngine?.enqueue({ workspaces: [toServerWorkspace(ws)], collections: [toServerCollection(defaultCol)] });
      usePlanStore.getState().incrementUsage("workspace");
      usePlanStore.getState().incrementUsage("collection");
      analytics.track("workspace_created");
      return ws;
```

- [ ] **Step 3: Track `collection_created` in `createCollection`**

In `createCollection` (around line 501), after `usePlanStore.getState().incrementUsage("collection");`, add:

```typescript
        analytics.track("collection_created");
```

The tail of the `guardQuota` callback becomes:

```typescript
        syncEngine?.enqueue({ collections: [toServerCollection(col)] });
        usePlanStore.getState().incrementUsage("collection");
        analytics.track("collection_created");
        return col;
```

- [ ] **Step 4: Verify build**

```bash
bun run compile
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add store/workspace-store.ts
git commit -m "feat(analytics): track workspace_created and collection_created events"
```

---

## Task 7: Feature event in `groups-store.ts`

**Files:**
- Modify: `store/groups-store.ts:1` (imports), `store/groups-store.ts:122` (`createGroup`)

- [ ] **Step 1: Add import**

At the top of `groups-store.ts`, add:

```typescript
import { analytics } from "@/lib/analytics";
```

- [ ] **Step 2: Track `group_saved` in `createGroup`**

In `createGroup` (line 122), after `usePlanStore.getState().incrementUsage("saved_group");`, add:

```typescript
      analytics.track("group_saved");
```

The tail of the `guardQuota` callback:

```typescript
      usePlanStore.getState().incrementUsage("saved_group");
      analytics.track("group_saved");
      return id;
```

- [ ] **Step 3: Verify build**

```bash
bun run compile
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add store/groups-store.ts
git commit -m "feat(analytics): track group_saved event"
```

---

## Task 8: Search event in `search-box.tsx`

**Files:**
- Modify: `components/dashboard/search-box.tsx:1` (imports), `components/dashboard/search-box.tsx:101` (`handleSelect`)

- [ ] **Step 1: Add import**

At the top of `search-box.tsx`, add:

```typescript
import { analytics } from "@/lib/analytics";
```

- [ ] **Step 2: Track `search_used` in `handleSelect`**

`handleSelect` (line 101) handles three cases: tab focus, bookmark open, and search engine fallback. Add tracking at the start of each branch before the navigation call.

Replace the `handleSelect` function:

```typescript
  const handleSelect = React.useCallback((index: number) => {
    if (index < filteredTabs.length) {
      const tab = filteredTabs[index];
      analytics.track("search_used", { type: "tabs" });
      chrome.tabs.update(tab.id, { active: true });
      chrome.windows.update(tab.windowId, { focused: true });
    } else if (index < filteredTabs.length + bookmarkResults.length) {
      const url = bookmarkResults[index - filteredTabs.length].url;
      const existingTab = openTabs.find(t => t.url === url);
      analytics.track("search_used", { type: "bookmarks" });
      if (existingTab) {
        chrome.tabs.update(existingTab.id, { active: true });
        chrome.windows.update(existingTab.windowId, { focused: true });
      } else {
        window.location.href = url;
      }
    } else {
      analytics.track("search_used", { type: "engine" });
      window.location.href = engine.url.replace("%s", encodeURIComponent(query.trim()));
    }
    setQuery("");
  }, [bookmarkResults, filteredTabs, openTabs, engine, query]);
```

- [ ] **Step 3: Verify build**

```bash
bun run compile
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add components/dashboard/search-box.tsx
git commit -m "feat(analytics): track search_used event"
```

---

## Task 9: Sync error event in `sync-engine.ts`

**Files:**
- Modify: `lib/sync-engine.ts:1` (imports), `lib/sync-engine.ts:186` (`setStatus`)

- [ ] **Step 1: Add import**

At the top of `sync-engine.ts`, add:

```typescript
import { analytics } from "@/lib/analytics";
```

- [ ] **Step 2: Track `sync_error` in `setStatus`**

`setStatus` (line 186) is where error status is applied. Add tracking inside the two places where `"error"` status is dispatched. The `errorMessage` may contain sensitive info — only pass a truncated, sanitized version.

Replace `setStatus`:

```typescript
  private setStatus(s: SyncStatus, errorMessage?: string) {
    this.lastErrorMessage = s === "error" ? (errorMessage ?? null) : null;
    if (this.status !== s) {
      this.status = s;
      this.onStatusChange(s, this.lastErrorMessage ?? undefined);
      if (s === "error") {
        analytics.track("sync_error", { message: (errorMessage ?? "unknown").slice(0, 100) });
      }
    } else if (s === "error" && errorMessage !== undefined) {
      this.onStatusChange(s, errorMessage);
      analytics.track("sync_error", { message: errorMessage.slice(0, 100) });
    }
  }
```

The `.slice(0, 100)` prevents accidentally sending a long error message that might contain a token fragment or URL with query params.

- [ ] **Step 3: Verify build**

```bash
bun run compile
```

Expected: no errors.

- [ ] **Step 4: Full build sanity check**

```bash
bun run build
```

Expected: build succeeds with no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add lib/sync-engine.ts
git commit -m "feat(analytics): track sync_error event"
```

---

## Task 10: Final verification

- [ ] **Step 1: Full type check**

```bash
bun run compile
```

Expected: exit 0, no errors.

- [ ] **Step 2: Production build**

```bash
bun run build
```

Expected: `.output/chrome-mv3/` directory generated without errors.

- [ ] **Step 3: Verify manifest has host_permissions**

```bash
cat .output/chrome-mv3/manifest.json | grep -A2 host_permissions
```

Expected (when `VITE_OPENPANEL_URL` is set):
```json
"host_permissions": ["https://your-openpanel.com/*"]
```

If `VITE_OPENPANEL_URL` is not set in `.env.local`, `host_permissions` will be absent — that is correct behavior (no-op mode).

- [ ] **Step 4: Smoke test in browser**

Load the unpacked extension from `.output/chrome-mv3/`. Open a new tab. Open DevTools → Network. Filter by `track`. Navigate to `/favorites`. Confirm a POST to `https://your-openpanel.com/api/track` with `name: "page_view"` appears. Add a bookmark. Confirm `name: "bookmark_added"` appears.

- [ ] **Step 5: Final commit**

```bash
git add -p  # review any remaining unstaged changes
git commit -m "feat: complete OpenPanel analytics integration"
```
