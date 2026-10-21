# Image Card View (Sub-project C1)

## Summary

The bookmark list offers a grid view and a list view, and neither shows what a page looks like. This sub-project replaces the list view with a large card view that shows each page's `og:image` as a cover. The extension reads the cover URL from the page when the bookmark is saved, stores it on the bookmark, and syncs it; the image itself loads straight from the site. Bookmarks without a cover, and covers that fail to load, show a generated placeholder. The small card view (today's grid) does not change.

Covers cost nothing to run and are free for every user, guests included. Server-side page capture, including stored copies of covers, belongs to sub-project C2 (web snapshots).

So that covers can be read when the optional all-sites permission is not granted, the extension adds the `activeTab` permission and injects its page reader when the user saves from the toolbar popup, the save shortcut, or the context menu.

For bookmarks that were not saved from an open page (typed into the form, imported, or saved before this change), the bookmark form gains a "Fetch details" button. It reads the page's title, description, and cover from the browser, without going through TabSlate's server.

## Roadmap Context

This is the third sub-project derived from the faved.to comparison (see `docs/superpowers/specs/2026-10-15-library-management-basics-design.md`). Each has its own spec, plan, and implementation cycle.

| Sub-project | Scope | Repositories |
|---|---|---|
| A — Library management basics | View preferences, tag and collection editing, counts, tag search, clickable tags, save shortcut, duplicate detection | Frontend |
| B — Bulk operations and unified form | Multi-select and bulk bar, unified add/edit form, notes, edit time, more sort options | Frontend + server |
| **C1 — Image card view** (this spec) | Small and large card views, `og:image` covers read at save time, placeholders | Frontend + server (one field) |
| C2 — Web snapshots | Server-side page capture (reader text, screenshot, cover copy, full-page archive), snapshot viewer, storage quota | Server + cloud + frontend |
| D — Nested tags and import hierarchy | Tag hierarchy, parent rollups, folder hierarchy preserved on import | Frontend + server |
| E — Onboarding | Seed content and guided first-run steps | Frontend |

C originally covered preview images, metadata refetch, AI summaries, and archived page content. During design it split in two. A server pipeline that only produces card images is heavy to run and hard to sell as a paid feature, so covers became this lightweight, free sub-project. Server-side capture became C2, a paid web snapshot feature modeled on Karakeep that keeps pages readable after their sites change or disappear. AI summaries are deferred until after C2.

**Depends on B.** C1 starts after B is merged. It changes `BookmarkCard`, `BookmarksContent`, `FavoritesContent`, and the bookmark form, which B also changes, and it removes the list variant that B extends with selection and notes.

## Goals

- Show each page's cover image in a new large card view.
- Keep the small card view exactly as it is.
- Read covers at save time, with no server-side fetching.
- Read page metadata when saving from the popup, the save shortcut, or the context menu, even without the optional all-sites permission.
- Sync covers across devices.
- Let users fetch a page's title, description, and cover into the bookmark form on request, including for typed-in and older bookmarks.

## Non-goals

- Server-side fetching of covers or metadata, and stored copies of cover images (C2).
- Automatic covers for existing bookmarks, imports, tabs dragged onto a collection, or bookmarks added by typing a URL into the form. The form's "Fetch details" button covers them on request; nothing fetches them in the background.
- Choosing or editing a cover by hand.
- Screenshots as covers.
- Covers in the small card view, the Archive and Trash pages, search results, or the popup.
- Reading page metadata during bulk tab saves without the optional all-sites permission.

## Decisions

| Question | Decision |
|---|---|
| View modes | Small cards (today's grid, unchanged) and large cards. The list view is removed. |
| Cover source | The page's `og:image`, or its `twitter:image` when `og:image` is missing, read when the bookmark is saved. |
| Missing or broken cover | A generated placeholder. |
| Cost and availability | Free for every user, guests included. The server never fetches pages for covers. |
| Saves without the optional all-sites permission | Add `activeTab` and inject the page reader for popup, shortcut, and context-menu saves. |
| Sync | A new `image_url` bookmark field, additive like B's notes. |
| URL edits | Saving a changed URL in the form clears the cover, unless details were fetched for the new URL. |
| Typed-in and older bookmarks | A "Fetch details" button in the bookmark form reads the page from the browser, asking for access to that one site when needed. |

## Design

### 1. View modes

`BookmarkViewMode` in `lib/view-preferences.ts` becomes `"grid" | "gallery"`:

- `grid` is the small card view. It stays the default and keeps its stored value, so existing preferences are unchanged.
- `gallery` is the large card view.
- A stored `list` value, local or synced, parses to the default through A's existing fallback for unknown values. An older extension that reads `gallery` from `/preferences` falls back to its default the same way.

The header's view toggle shows two buttons, "Small cards" and "Large cards". The main list (`BookmarksContent`) and the Favorites page (`FavoritesContent`) render the selected view. The Archive and Trash pages keep their own cards.

`BookmarkCard`'s `variant` becomes `"grid" | "gallery"`. The list variant is removed, along with code that only it uses, including B's list-variant placement of the selection checkbox and the notes button.

### 2. Large card

A large card is a small card with a cover on top.

- **Cover** (`BookmarkCover`):
  - Full card width, fixed 1.91:1 aspect ratio (the standard `og:image` ratio), `object-fit: cover`, rounded top corners.
  - The `<img>` uses `loading="lazy"`, `decoding="async"`, `referrerPolicy="no-referrer"` (many hotlink rules allow requests without a referrer), `alt=""` (the title is right below), and `draggable={false}`.
  - A load error switches the cover to the placeholder. Failed URLs are remembered for the rest of the page session, so virtualized rows that mount again do not retry them.
- **Placeholder** (`BookmarkCoverPlaceholder`):
  - Same size as the cover.
  - A soft background color picked from a fixed palette by a hash of the bookmark's host, with light and dark variants.
  - The bookmark's favicon (`FaviconImage`) and host name, centered.
  - It makes no request besides the favicon the card already loads.
- **Below the cover**: the small card's content (drag handle, favicon, title, hover actions, notes button, description, and tags), except that the title wraps to at most two lines.
- **Selection checkbox**: B's checkbox moves from the favicon square to the top-left corner of the cover, with the same visibility rules.
- Clicks, Shift and Cmd/Ctrl selection, dragging, the right-click and ⋯ menus, tag filters, and the highlight flash behave exactly as on small cards.

**Layout.** Large cards use the small cards' column breakpoints (one to four columns by container width). The virtualizer measures rows (`measureElement` is already in use); the initial height estimate for a large card row is larger than for a small card row.

### 3. Reading covers

**Page reader.** `lib/page-info.ts` exports `readPageInfo()`, a self-contained function that returns what `GET_PAGE_INFO` returns today (`title`, `url`, `selectedText`, `favicon`, `ogTitle`, `metaDescription`) plus `ogImage`: the raw `content` of `meta[property="og:image"]`, else of `meta[name="twitter:image"]` or `meta[property="twitter:image"]`, else `""`. It references no imports or outer variables, so it can run inside the content script and through `chrome.scripting.executeScript({ func })`. `entrypoints/content.ts` answers `GET_PAGE_INFO` by calling it.

**Normalization.** `normalizeCoverUrl(raw, pageUrl)` in `lib/bookmark-utils.ts` resolves `raw` against the page URL and returns the absolute URL only if its scheme is `http:` or `https:` and it is at most `MAX_BOOKMARK_IMAGE_URL_LENGTH = 2048` characters long; otherwise it returns `undefined`. The scheme rule also drops `data:` URIs. Every save path normalizes before storing.

**Requesting page info.** `requestPageInfo(tabId, { allowInjection })` in `lib/page-info.ts`:

1. Sends `GET_PAGE_INFO` to the tab's content script. This is the existing path, available when the optional all-sites permission is granted.
2. If that fails and `allowInjection` is set, runs `readPageInfo` in the tab with `chrome.scripting.executeScript`. This works on the active tab right after the user opens the popup (toolbar click or save shortcut) or picks the context-menu item, because those actions grant `activeTab`.
3. If both fail (browser pages, extension stores, PDF viewers, or no `activeTab` grant), it resolves to `null`. Callers keep today's fallback to the tab's own title, URL, and favicon, with no cover.

The popup and the background pass `allowInjection: true`. Bulk tab saves from the new tab page (`store/tabs-store.ts`) use step 1 only, because no user action grants access to each tab.

**Save paths that store a cover:**

- the popup save, both through the `ADD_BOOKMARK` message (`data.imageUrl`) and the IndexedDB fallback in `lib/storage.ts` (`BookmarkInput.imageUrl`);
- the context-menu save in `entrypoints/background.ts`, both through the message and its IndexedDB fallback;
- saving a window or a tab group as a collection (`saveWindowAsCollection` and `saveGroupAsCollection`, through `_saveTabsToCollectionHelper` in `store/tabs-store.ts`).

Bookmarks added by typing a URL into the form, tabs dragged onto a collection (that path reads no page info today and keeps it that way), imported bookmarks, and the existing library have no cover.

**URL edits.** When the bookmark form saves a changed URL, it also saves `imageUrl: ""`, which clears the cover, unless "Fetch details" ran for the new URL (section 6). Bulk actions never change covers.

**Manifest.** `wxt.config.ts` adds `activeTab` to the permissions of the Chromium and Firefox builds. Neither browser shows an install or update warning for it. `test/wxt-config.test.ts` asserts it for both builds.

### 4. Data and sync

**Client.**

- `Bookmark` in `lib/types.ts` gains `imageUrl?: string`. A missing value or `""` means no cover, so existing IndexedDB records need no migration.
- `toServerBookmark` always sends `image_url: imageUrl ?? ""`, so a cleared cover syncs.
- `mergeFromServer` uses `serverBookmark.image_url ?? existing?.imageUrl ?? ""`, so a server that predates the field never clears a local cover.
- The sync confirmation comparisons (`entityMatchesBookmark` in `store/bookmarks-store.ts` and the record comparison in `lib/sync-confirmation.ts`) compare covers, treating a missing value as `""`.
- `ServerBookmark` in `lib/api.ts` gains `image_url?: string`.
- `updateBookmark` and B's `updateBookmarks` accept `imageUrl` in patches. Only the form sets it.

**Server (TabSlate-server).**

- Schema (`db/schema.pg.sql`, idempotent):

  ```sql
  ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS image_url TEXT NOT NULL DEFAULT '';
  ```

- Model (`internal/model/model.go`): `Bookmark` gains `ImageURL *string json:"image_url,omitempty"`. A nil pointer means the client did not send the field. `BookmarkRequest` gains `ImageURL *string json:"image_url" binding:"omitempty,max=2048"`.
- Sync push (`internal/handler/sync.go`):
  - A non-empty value must parse as an absolute `http` or `https` URL of at most 2,048 characters; otherwise the bookmark is rejected with reason `invalid_field`. The extension never sends such values, so this only stops malformed clients.
  - Insert stores `COALESCE($image_url, '')`. Update stores `COALESCE($image_url, bookmarks.image_url)` under the existing `updated_at < $now` condition, so a push without the field keeps the stored cover and `""` clears it.
- Sync pull selects and returns `image_url`. Because the column is never NULL, a new server always sends the field, which lets a cleared cover reach other devices.
- REST (`internal/handler/bookmarks.go`): reads return the field, create stores `COALESCE($image_url, '')`, and update keeps the stored value when the field is absent, with the same validation as push.
- Search indexing ignores the field. Conflict handling, `updated_at`, and B's `edited_at` are unchanged.

**TabSlate-cloud.** Build and run the test suite against the updated server through the local `replace` directive. No code changes are expected.

**Compatibility.**

| Combination | Behavior |
|---|---|
| New extension, old server | The server ignores `image_url`. Covers stay on the device that saved them, and pulls never clear them. |
| Old extension, new server | Its pushes omit `image_url`, so stored covers are kept. It does not show covers. |
| New extension, new server | Covers sync. |

**Deployment order.** TabSlate-server, then TabSlate-cloud, then the extension. The extension also works against servers that have not been updated.

### 5. Privacy and Firefox data collection

- The cover URL is page metadata stored with the bookmark. Like descriptions and B's notes, it is synced only with the existing account-data consent and is filed under the already declared `websiteContent` category.
- The large card view loads images from the sites, or their image hosts, of the bookmarks on screen. Like the favicon lookups, this falls under the already required `browsingActivity` category. The requests carry no referrer.
- The declared categories do not change. The comment on `FIREFOX_ACCOUNT_DATA_COLLECTION` in `lib/browser/data-collection-permissions.ts` and the Firefox bullet in `CLAUDE.md` mention covers.
- `activeTab` grants temporary access only to the tab the user acted on, and the injected function only reads metadata from the page.
- "Fetch details" (section 6) requests the page straight from the user's browser, without cookies, like opening the link. Nothing is sent to TabSlate's server or to third parties, so no data-collection category is involved.

### 6. Fetch details in the bookmark form

B's bookmark form gains a "Fetch details" button next to the URL field, in add and edit mode. It is how typed-in, imported, and older bookmarks get a title, description, and cover, and how users refresh them.

- **Access.** The page is fetched from the new tab page, which needs host access to the URL's origin. If the optional all-sites permission is not granted, the click handler requests `<origin>/*` before any `await` (allowed by the existing `optional_host_permissions: ["<all_urls>"]`). The browser's prompt names the site. A refusal shows "Allow access to this site to fetch its details" and changes nothing.
- **Request.** `fetch(url, { credentials: "omit", redirect: "follow" })` with a 10-second timeout. At most 2 MB of the body is read, and only `text/html` and `application/xhtml+xml` responses are parsed.
- **Parsing.** `DOMParser` parses the HTML, so page scripts never run.
  - Title: `og:title`, else `<title>`.
  - Description: `og:description`, else `meta[name="description"]`.
  - Cover: `og:image`, else `twitter:image`, normalized with `normalizeCoverUrl` against the final response URL.
- **Applying.**
  - Empty title and description fields are filled.
  - A non-empty field shows a one-line suggestion, "Use fetched: «…»", which replaces the value when clicked. The user's text is never overwritten silently.
  - A fetched cover replaces the bookmark's cover and shows as a small thumbnail beside the button.
  - Nothing is saved until the form is saved.
- **Errors.** Timeouts, network errors, non-HTML responses, and pages without metadata show an inline message and change nothing.
- The logic lives in `lib/page-metadata.ts` (`fetchPageMetadata(url)`), which shares its tag selectors with `readPageInfo`.

## Components and Files

Frontend, new:

- `lib/page-info.ts` — `PageInfo`, `readPageInfo()`, and `requestPageInfo()`.
- `components/dashboard/bookmark-cover.tsx` — `BookmarkCover` and `BookmarkCoverPlaceholder`.
- `lib/page-metadata.ts` — `fetchPageMetadata(url)` for the form's "Fetch details" button.

Frontend, modified:

- `lib/view-preferences.ts` (`gallery` replaces `list`), `lib/types.ts` (`imageUrl`), `lib/bookmark-utils.ts` (`normalizeCoverUrl`, `MAX_BOOKMARK_IMAGE_URL_LENGTH`), `lib/api.ts` (`image_url`), `lib/storage.ts` (`BookmarkInput.imageUrl`), `lib/sync-confirmation.ts`
- `store/bookmarks-store.ts` (mapping, merge, confirmation, patches), `store/tabs-store.ts` (cover on tab saves)
- `entrypoints/content.ts`, `entrypoints/popup/App.tsx`, `entrypoints/background.ts`
- `components/dashboard/bookmark-card.tsx`, `content.tsx`, `favorites-content.tsx`, `header.tsx`, `shared/bookmark-form.tsx`
- `wxt.config.ts`, `test/wxt-config.test.ts`
- `lib/browser/data-collection-permissions.ts` (comment), both `messages.json`, `CLAUDE.md` (`GET_PAGE_INFO` fields, view modes, `activeTab`, covers in the Firefox bullet), `ARCHITECTURE.md`

TabSlate-server: `db/schema.pg.sql`, `internal/model/model.go`, `internal/handler/sync.go`, `internal/handler/bookmarks.go`, their tests, and the server's `CLAUDE.md` and `ARCHITECTURE.md`.

TabSlate-cloud: none (build and test only).

## Error Handling

- Reading page info never blocks a save. Any failure falls back to the tab's title, URL, and favicon without a cover, as today. Injection errors are caught.
- The client drops invalid and overlong cover URLs before saving. The server's `invalid_field` rejection only stops malformed clients.
- Broken images show the placeholder and are not retried during the page session.

## Testing

Each behavior is implemented test-first, with the happy-dom helpers and module save-and-restore pattern from A.

- **Unit tests:** `normalizeCoverUrl` (relative URLs, schemes, `data:` URIs, length); `readPageInfo` against happy-dom documents (`og:image`, the `twitter:image` fallback, neither); `requestPageInfo` (content-script path, injection fallback, `null` when both fail, no injection without `allowInjection`); view-preference parsing (`gallery` accepted, `list` falls back to `grid`); `toServerBookmark`, `mergeFromServer`, and both confirmation comparisons with covers, including clearing and the old-server fallback; a stable placeholder color for a host.
- **Component tests:** the header toggle; a large card with a cover, without one, and after an image error, including no retry after the row mounts again; the checkbox on the cover; `BookmarksContent` and `FavoritesContent` in the large card view; the form clearing the cover when the URL changes.
- **Fetch details:** `fetchPageMetadata` against stubbed responses (Open Graph tags, fallbacks, relative cover URLs, non-HTML, oversized bodies, timeouts); the form's button requesting site access in the click handler, filling empty fields, offering replacements for filled ones, keeping the fetched cover through a URL change, and showing errors.
- **Entry points:** the popup and the context-menu save pass the normalized cover through `ADD_BOOKMARK` and their IndexedDB fallbacks; saving a window or a tab group stores each tab's cover from the content script.
- **Manifest test:** `activeTab` in the Chromium and Firefox builds.
- **Server tests** (Go, in the existing handler test style): push stores, keeps (absent field), clears (`""`), and rejects (bad scheme, too long) covers; pull and REST return the field; REST update keeps an absent cover; the schema migration runs twice without error.
- **Cloud:** `go test ./...` after the server change.
- **Manual check:** in Chrome and Firefox without the optional all-sites permission, save a page that has an `og:image` from the popup, the save shortcut, and the context menu; check the large card view, a site that blocks hotlinking (placeholder), placeholders in dark mode, and that a second signed-in profile shows the cover after sync.

## Accessibility and Internationalization

- The view toggle buttons have accessible labels ("Small cards", "Large cards") and `aria-pressed`.
- Covers are decorative (`alt=""`), and the placeholder is `aria-hidden`; the title next to them names the bookmark.
- New strings are translated in English and Simplified Chinese with `[component]_[description]` keys. The list view's toggle label is removed.

## Resolved During Design

- **No server-side covers.** A server fetch pipeline that only produces card images is heavy to operate and hard to explain as a paid feature. Server-side capture moves to C2 as web snapshots, which also store a copy of the cover.
- **`activeTab`.** Without the optional all-sites permission, the content script is not registered, so saves from the popup and the context menu got no page metadata at all. `activeTab` grants temporary access on exactly those user actions, without an install warning.
- **`og:image` with a `twitter:image` fallback.** Both are page-declared share images; no other image sources (largest image, screenshots) are used.
