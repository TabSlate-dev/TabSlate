# OpenPanel Analytics Integration — Design Spec

**Date:** 2026-05-30  
**Approach:** Custom thin fetch-based analytics module (方案 B)

---

## Goal

Add self-hosted OpenPanel analytics to the TabSlate Chrome extension to track four event categories: lifecycle events, page views, feature usage, and sync errors. All tracking is anonymous (random session ID, no user identity).

---

## Architecture

### New file

**`lib/analytics.ts`** — single analytics module shared across all extension contexts (newtab, popup, background service worker).

Public API:
```ts
analytics.init(): Promise<void>        // reads/creates sessionId from storage
analytics.track(name: string, properties?: Record<string, string | number | boolean>): void
```

Internal behavior:
1. On `init()`: read `tabslate-analytics-id` from `chrome.storage.local`. If absent, generate `crypto.randomUUID()` and persist it.
2. On `track()`: if `VITE_OPENPANEL_URL` or `VITE_OPENPANEL_CLIENT_ID` is empty → no-op (safe in dev).
3. Fire-and-forget `fetch` POST to `/api/track`. Errors are silently swallowed (analytics must never crash the extension).

### No new files beyond `lib/analytics.ts`

All call sites are additions to existing files.

---

## OpenPanel API Contract

```
POST {VITE_OPENPANEL_URL}/api/track
Headers:
  openpanel-client-id: {VITE_OPENPANEL_CLIENT_ID}
  Content-Type: application/json
Body:
  {
    "type": "track",
    "payload": {
      "name": "<event_name>",
      "profileId": "<sessionId>",
      "properties": { ... }
    }
  }
```

---

## Environment Variables

Add to `.env.local` (not committed):

```bash
VITE_OPENPANEL_URL=https://your-openpanel.com
VITE_OPENPANEL_CLIENT_ID=your-client-id
```

Both must be set for tracking to activate. Either being empty disables all tracking silently.

---

## Manifest Permissions (`wxt.config.ts`)

Extend the existing `build:manifestGenerated` hook — no new hook needed:

```ts
"build:manifestGenerated": (wxt, manifest) => {
  delete manifest.host_permissions; // existing logic

  // Inject OpenPanel origin so extension pages can fetch without CORS
  const openpanelUrl = process.env.VITE_OPENPANEL_URL;
  if (openpanelUrl) {
    const origin = new URL(openpanelUrl).origin + "/*";
    manifest.host_permissions = [origin];
  }
},
```

This grants `connect-src` access to the OpenPanel server for extension pages (newtab, popup) and the background service worker, bypassing CORS entirely. No user permission prompt is triggered.

---

## Session ID Management

- **Storage key:** `tabslate-analytics-id` in `chrome.storage.local`
- **Lifetime:** Persists across browser restarts (intentional — supports funnel analysis)
- **Generation:** `crypto.randomUUID()` on first `init()` call
- **Privacy:** No user-identifiable information. `profileId` is the random UUID only.
- `analytics.init()` is called once in `background.ts` on startup. The newtab context uses `analytics.track()` directly after background has initialized the ID.

---

## Event Catalog

### Lifecycle — `entrypoints/background.ts`

| Event | Trigger | Properties |
|---|---|---|
| `extension_installed` | `onInstalled` with `reason === "install"` | `version: string` |
| `extension_updated` | `onInstalled` with `reason === "update"` | `version: string`, `previousVersion: string` |

### Page Views — `entrypoints/newtab/App.tsx`

| Event | Trigger | Properties |
|---|---|---|
| `page_view` | Route change `useEffect([location.pathname])` | `path: string` |

Paths tracked: `/bookmarks`, `/favorites`, `/archive`, `/trash`, `/tabs`, `/groups`, `/group/:id`.

### Feature Usage — store actions

| Event | Call site | Properties |
|---|---|---|
| `bookmark_added` | `bookmarks-store.ts` → `addBookmark` | `source: "popup" \| "newtab" \| "context_menu"` |
| `collection_created` | `workspace-store.ts` → `addCollection` | — |
| `workspace_created` | `workspace-store.ts` → `addWorkspace` | — |
| `group_saved` | `groups-store.ts` → `saveGroupFromChrome` | — |
| `bookmark_imported` | `bookmarks-store.ts` → `_bulkAddBookmarks` | `count: number` |
| `search_used` | `components/dashboard/search-box.tsx` on result select | `type: "bookmarks" \| "tabs" \| "engine"` |

### Errors — `lib/sync-engine.ts`

| Event | Trigger | Properties |
|---|---|---|
| `sync_error` | `OnStatusChange` called with `status === "error"` | `message: string` (sanitized, no tokens) |

---

## Data Flow

```
newtab / popup
  └── analytics.track("page_view", ...)
        └── fetch POST /api/track  ← allowed by host_permissions

background.ts
  └── analytics.init()             ← generates/loads sessionId
  └── analytics.track("extension_installed", ...)
        └── fetch POST /api/track

store actions (bookmarks-store, workspace-store, groups-store)
  └── analytics.track("bookmark_added", ...)
        └── fetch POST /api/track

sync-engine.ts
  └── analytics.track("sync_error", ...)
        └── fetch POST /api/track
```

All `fetch` calls originate from extension contexts (never content scripts), so CORS is fully bypassed via `host_permissions`.

---

## Error Handling

- All `fetch` errors in `analytics.ts` are caught and silently ignored.
- A missing/unreachable OpenPanel server must never affect extension functionality.
- No retries — analytics events are best-effort.

---

## What Is Not Tracked

- User email, user ID, or any PII
- Individual bookmark content or URLs
- Search queries
- Tab titles or URLs

---

## Files Changed

| File | Change |
|---|---|
| `lib/analytics.ts` | **New** — thin analytics module |
| `wxt.config.ts` | Extend `build:manifestGenerated` hook to inject `host_permissions` |
| `.env.local` | Add `VITE_OPENPANEL_URL` + `VITE_OPENPANEL_CLIENT_ID` (not committed) |
| `entrypoints/background.ts` | `analytics.init()` + lifecycle events |
| `entrypoints/newtab/App.tsx` | `page_view` tracking on route change |
| `store/bookmarks-store.ts` | `bookmark_added`, `bookmark_imported` events |
| `store/workspace-store.ts` | `collection_created`, `workspace_created` events |
| `store/groups-store.ts` | `group_saved` event |
| `components/dashboard/search-box.tsx` | `search_used` event |
| `lib/sync-engine.ts` | `sync_error` event |
