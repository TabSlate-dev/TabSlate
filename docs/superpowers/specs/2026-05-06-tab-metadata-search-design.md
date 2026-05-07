# Tab Metadata & Unified Search Design

**Date:** 2026-05-06
**Status:** Approved

## Overview

Enhance TabSlate to capture richer tab metadata at save time (og:title, meta description) and introduce a unified search experience that searches saved bookmarks via MeiliSearch on the backend, open tabs locally, and falls back to Google when no results are found.

---

## Section 1: Metadata Capture (at Save Time)

### What is captured

Extend the existing `GET_PAGE_INFO` message handler in `content.ts` to extract two additional fields:

- `ogTitle`: value of `meta[property="og:title"]` content attribute
- `metaDescription`: value of `meta[property="og:description"]` → fallback to `meta[name="description"]`

### When it is captured

Only at the moment a tab is saved as a bookmark — in `_saveTabsToCollectionHelper` (tabs-store) and the popup save path. No background polling or batch pre-fetching.

The save caller (newtab context or popup context) sends `GET_PAGE_INFO` via `chrome.tabs.sendMessage` to the target tab before constructing the `Bookmark` object. No routing through `background.ts` is required.

### How it is applied

- `ogTitle` (if non-empty) replaces `tab.title` as the bookmark title.
- `metaDescription` populates `Bookmark.description` (currently always saved as `""`).

### Constraints

- `Bookmark` type in `lib/types.ts` requires no structural changes.
- If `GET_PAGE_INFO` times out or the tab is not injectable (e.g. `chrome://` pages), fall back gracefully to `tab.title` and empty description.

---

## Section 2: MeiliSearch — Index Schema & User Isolation

### Deployment

MeiliSearch runs as a single Docker container accessible only on the internal network. It is never exposed to the public internet. Both `TabSlate-server` (OSS) and `TabSlate-Cloud` connect to it over the internal network.

### Index document structure

```json
{
  "id": "<bookmark.id>",
  "userId": "<user.id>",
  "title": "string",
  "url": "string",
  "description": "string",
  "collectionId": "string",
  "isArchived": false
}
```

### User isolation

Every query from the Go backend unconditionally appends `filter: userId = "<id>"` derived from the authenticated JWT. The frontend never communicates with MeiliSearch directly.

### Write events

| Event | Action |
|---|---|
| Bookmark created or updated (active or archived) | Upsert document (`isArchived` reflects `archivedAt != null`) |
| Bookmark trashed (`deletedAt` set) | Delete document from index |
| Bookmark restored from trash | Re-upsert document |
| User account deleted | Batch-delete all documents where `userId = "<id>"` |

Write operations are asynchronous (fire-and-forget from the API handler) and do not block the HTTP response.

---

## Section 3: Go Search API

### Endpoint

```
GET /api/search?q=<query>
Authorization: Bearer <access_token>
```

### Behavior

1. Extract `userId` from JWT.
2. Forward query to MeiliSearch with mandatory filter `userId = "<userId>"`.
3. Return matched bookmarks.

### Response shape

```json
{
  "bookmarks": [
    {
      "id": "string",
      "title": "string",
      "url": "string",
      "description": "string",
      "collectionId": "string",
      "isArchived": true
    }
  ]
}
```

### Frontend call constraints

- Minimum query length: 2 characters.
- Debounce: 300ms after last keystroke.
- The endpoint is called by both the content-page search bar and the Ctrl+Shift+K popup — they share the same `lib/api.ts` function.

---

## Section 4: Search UI

### Shared component

Both search entry points render the same `components/search/search-panel.tsx` component. It accepts the current open tabs list as a prop and manages its own query state, debounced API call, and keyboard navigation internally.

### Result panel structure

Three sections rendered in a dropdown/overlay below the search input:

```
┌──────────────────────────────────────────┐
│  🔖 Bookmarks (N)                        │  ← MeiliSearch results
│    • Title  domain.com                   │
│      Description snippet      [Archived] │  ← badge when isArchived
├──────────────────────────────────────────┤
│  🌐 Open Tabs (N)                        │  ← local title+URL filter
│    • Tab Title  domain.com               │
├──────────────────────────────────────────┤
│  🔍 Search "query" on Google             │  ← always visible at bottom
└──────────────────────────────────────────┘
```

- Archived bookmarks show a small `Archived` badge as informational context only. Clicking opens the bookmarked URL directly in a new tab — does not navigate to `/archive`.
- The Google fallback row is always rendered at the bottom regardless of result count.
- When both Bookmarks and Open Tabs return zero results, the Google row is auto-focused.
- Selecting any item opens its URL via `chrome.tabs.create`. In the content-page variant (4A), `smartOpenUrl` is used instead to reuse an already-open tab if one exists.
- Keyboard: `↑` / `↓` to navigate rows, `Enter` to open selected. `Escape` closes the panel.
- Activating the Google row: `chrome.tabs.create({ url: "https://www.google.com/search?q=<encoded_query>" })`.

### 4A — Content page inline search

Location: top of `BookmarksContent` (`components/dashboard/content.tsx`), **above** the bookmark grid, independent of `header.tsx`. The existing header search input (`searchQuery` in `useBookmarksStore`) is not modified.

The inline search has its own local state (not stored in Zustand). Results dropdown appears below the input and is dismissed on `Escape` or outside click.

`BookmarksContent` reads `openTabs` from `useTabsStore` and passes them as a prop to `SearchPanel`. If `openTabs` is empty (e.g. user is on `/` without having visited `/tabs`), `BookmarksContent` calls `loadTabs()` once on mount to ensure the open-tabs section is populated.

### 4B — Global Ctrl+Shift+K popup window

**Manifest registration** (`wxt.config.ts`):

```ts
commands: {
  "open-search": {
    suggested_key: { default: "Ctrl+Shift+K", mac: "Command+Shift+K" },
    description: "Open TabSlate search",
  },
}
```

**Background handler** (`background.ts`):

```ts
chrome.commands.onCommand.addListener((command) => {
  if (command === "open-search") {
    chrome.windows.create({
      url: chrome.runtime.getURL("search.html"),
      type: "popup",
      width: 640,
      height: 420,
      focused: true,
    });
  }
});
```

**New entrypoint:** `entrypoints/search/` — standalone React tree. Renders `SearchPanel` with `autoFocus`. On item selection, calls `chrome.tabs.create` and then `window.close()`.

The search entrypoint shares `useAuthStore` (for `accessToken` and `serverUrl`) and `useTabsStore` (for open tabs). On mount, `useAuthStore` hydrates via its existing `chrome.storage` persist adapter, and `useTabsStore.loadTabs()` is called explicitly (it is non-persistent and has no adapter). `SearchPanel` renders only after both are ready.

---

## Out of Scope (this spec)

- Searching open tabs metadata (no background pre-fetch of metadata for unsaved tabs).
- Full-text body/content extraction beyond og/meta tags.
- `meta keywords` field.
- `og:image` as bookmark cover.
- Modifying the existing header search bar behavior.
- Search within the `/tabs`, `/archive`, or `/trash` routes.
