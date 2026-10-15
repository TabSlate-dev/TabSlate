# Bulk Operations and Unified Bookmark Form (Sub-project B)

## Summary

TabSlate can only act on one bookmark at a time, edits bookmarks in three different dialogs, and has no place to write down why a page was saved. This sub-project adds multi-select with a bulk action bar, replaces the add, edit and tags dialogs with one bookmark form, adds plain-text notes, records when each bookmark was last edited, and adds "Date updated" and "Website" sort orders.

Notes and the edit time are new synced fields, so this sub-project changes TabSlate-server as well as the extension. Both fields are additive: older extensions and older servers keep working.

## Roadmap Context

This is the second of five sub-projects derived from the faved.to comparison (see `docs/superpowers/specs/2026-10-15-library-management-basics-design.md`). Each has its own spec, plan, and implementation cycle.

| Sub-project | Scope | Repositories |
|---|---|---|
| A — Library management basics | View preferences, tag and collection editing, counts, tag search, clickable tags, save shortcut, duplicate detection | Frontend |
| **B — Bulk operations and unified form** (this spec) | Multi-select and bulk bar, unified add/edit form, notes, edit time, more sort options | Frontend + server |
| C — Page snapshots and image view | Server-side preview images, metadata refetch, AI summary, archived page content, small-card and image-card views | Server + cloud + frontend |
| D — Nested tags and import hierarchy | Tag hierarchy, parent rollups, folder hierarchy preserved on import | Frontend + server |
| E — Onboarding | Seed content and guided first-run steps | Frontend |

**Depends on A.** B's plan starts after A is implemented. It extends A's view-preference sort list, moves A's duplicate notice from `AddBookmarkDialog` into the new form, reuses A's tag-name validation, and changes A's bookmark menu items to open the new form.

## Goals

- Select many bookmarks quickly (hover checkbox, Shift range, Cmd/Ctrl toggle) and act on all of them at once.
- Bulk move, tag, favorite, archive, delete, open (as tabs or as a tab group), and copy links.
- Add and edit bookmarks in one form that covers title, URL, description, notes, collection, and tags.
- Keep plain-text notes on bookmarks, synced and searchable.
- Sort by when a bookmark was last edited, and by website.
- Keep large bulk changes within the server's push limits.

## Non-goals

- Dragging a multi-selection (dragging still moves one card).
- Changing the selection UI of the Archive and Trash pages.
- Moving bookmarks to another workspace.
- Undo for bulk actions. Archive and Delete stay recoverable from the Archive and Trash pages, and their notices link there.
- Markdown or rich-text notes.
- "Recently opened" and manual ordering.
- Detecting servers that predate notes. On such a self-hosted server, notes stay on the device that wrote them.
- Touch-specific selection gestures and a Cmd/Ctrl+A shortcut.
- Notes on context-menu saves, which have no UI.

## Decisions

| Question | Decision |
|---|---|
| How selection starts | A checkbox on each card on hover; Shift+click selects a range; Cmd/Ctrl+click toggles; Esc clears. Once anything is selected, clicking a card selects it instead of opening it. |
| Bulk actions | Move to collection, Add/remove tags, Favorite/unfavorite, Archive, Delete, Open all in new tabs, Open as a tab group, Copy links (plain or Markdown). |
| Form container | A dialog. The form body is a separate component that sub-project C can reuse in a detail panel. |
| Notes format | Plain text, at most 10,000 characters; links are clickable when notes are shown. |
| New sort orders | Date updated (newest and oldest first) and Website (A–Z). |
| Implementation approach | A dedicated selection store, batch actions in the bookmarks store (one state update, one IndexedDB transaction, one sync enqueue per action), and additive server fields. |
| Source of "date updated" | A new client-reported `edited_at` column. The server's `updated_at` keeps its role in conflict resolution, because it records when the server received a push, which a guest's first sync after signing in would reset for every bookmark. |
| Firefox data-collection declaration | Notes are user-editable bookmark text like descriptions and are filed under the already declared `websiteContent`, so no new consent is needed. |

## Design

### 1. Selection

**State.** `store/selection-store.ts` holds an ephemeral, non-persisted selection:

- `selectedIds: ReadonlySet<string>` (replaced, never mutated, on every change) and `anchorId: string | null`;
- `toggle(id)` (sets the anchor to `id`), `selectRange(orderedIds, toId)` (adds every ID between the anchor and `toId` in `orderedIds`, inclusive, and keeps the anchor; without a usable anchor it behaves like `toggle(toId)`), `setMany(ids, selected)`, `retain(ids)` (drops IDs not in `ids`), and `clear()`.

A card subscribes with `s => s.selectedIds.has(bookmark.id)` and `s => s.selectedIds.size > 0`. Selecting a card re-renders that card only; selection becoming active or inactive re-renders the visible cards once, because their checkboxes appear or disappear.

**Views.** Selection works in the main list (`/`, `BookmarksContent`) and on the Favorites page (`FavoritesContent`), in grid and list view. Each view defines two orders:

- the **view order**: every bookmark the view lists, in display order. In "All bookmarks" this is the collection groups in sidebar order, then uncategorized, each sorted by the current sort, including bookmarks inside collapsed groups;
- the **on-screen order**: the view order without collapsed groups.

Each view provides both through a React context that cards read only when needed, so a list change does not re-render every card.

**Card behavior.**

| Input | Selection inactive | Selection active |
|---|---|---|
| Hover | The favicon square shows a checkbox (no layout shift) | Every card shows its checkbox |
| Click on the checkbox | Selects the card; anchor = card | Toggles the card; anchor = card |
| Click on the card | Opens the bookmark (unchanged) | Toggles the card; anchor = card |
| Shift+click | Selects the range from the anchor in on-screen order (adds to the selection); toggles the card when there is no anchor | Same |
| Cmd+click (macOS) / Ctrl+click (Windows, Linux) | Toggles the card, which starts a selection | Toggles the card |

- Shift+click does not select page text.
- The ⋯ and right-click menus still act on the single card, and dragging still moves one card.
- Clicking a tag chip on a card still filters by that tag (A); the filter change clears the selection.

**Esc** clears the selection unless another component already handled the key (`event.defaultPrevented`, which Radix sets when it closes a menu or dialog) or the key came from an editable element (input, textarea, select, contenteditable).

**Group headers.** In the grouped "All bookmarks" view, each collection header has a checkbox. It is checked when all of the collection's bookmarks in the view are selected, indeterminate when some are, and empty when none are. Clicking it selects all of them, including those in a collapsed group, or clears them when all were selected.

**Clearing and pruning.**

- The selection clears when the route, active workspace, selected collection, selected tags, filter type, or search query changes.
- Whenever the view order changes, the selection retains only IDs still in the view, so bookmarks moved away, unfavorited, archived, or deleted (locally or by sync) drop out.

### 2. Bulk action bar and actions

**Bar.** While the selection is active, the view renders a toolbar that sticks to the bottom of its scroll container:

`N selected · Move to… · Tags… · Favorite · Archive · Delete · Open ▾ · ⋯ · Select all · ✕`

- **Open ▾** offers "Open all in new tabs" and "Open as a tab group". The tab group item shows only when `supportsTabGroups()` is true, which it is for both the Chromium and the Firefox (142+) builds.
- **⋯** offers "Copy links" and "Copy as Markdown list". Below the `sm` breakpoint (640 px wide windows), Open and Archive move into ⋯.
- **Select all** selects every bookmark in the on-screen order. **✕** clears the selection.

**Store actions.** `bookmarks-store` gains three batch actions. Each one performs one `set()`, one `idbBulkWrite`, one `syncEngine?.enqueue()` (called outside the `set` updater), and one counts-invariant check. They act on active bookmarks only and silently skip IDs that are no longer active. The existing single-bookmark actions keep their current behavior, including `updateBookmark`'s handling of archived and trashed bookmarks.

| Action | Behavior |
|---|---|
| `updateBookmarks(patches: { id, patch }[])` | Applies per-bookmark changes to `title`, `url`, `description`, `notes`, `collectionId`, `tags`, or `isFavorite`. Patches that change nothing are dropped entirely (no write, no edit time). Changed bookmarks get `updatedAt = Date.now()`; collection counts follow collection changes. |
| `archiveBookmarks(ids)` | Stamps `updatedAt`, moves the bookmarks out of the active map, deletes them from `bookmarks` and puts them in `archived-bookmarks` in one transaction, and pushes them as archived. Follows the `_archivedLoaded` rule: when the archive is not loaded, the action writes IndexedDB only and leaves `archivedBookmarks` alone. |
| `trashBookmarks(ids)` | Mirrors `trashBookmark` for many bookmarks (local `deletedAt`, pushed as `is_trashed: 1`), stamps `updatedAt`, follows the `_trashedLoaded` rule, and calls `moveUsageToTrash("bookmark", n)` once. |

**Actions.** "Selected bookmarks in view order" means the selected bookmarks sorted by the view order.

| Action | Behavior | Afterwards |
|---|---|---|
| Move to… | A searchable list of the active workspace's active collections (default first, then by `position` descending) plus "New collection…". When the move runs, the target is checked again with `resolveActiveWorkspaceCollectionTarget`; if it is no longer valid, nothing is written and a "target unavailable" notice appears. Bookmarks already in the target are skipped. | Notice "Moved N bookmarks to «collection»"; selection clears |
| Tags… | A searchable tag list with three-state checkboxes computed from the selection: checked when every selected bookmark has the tag, indeterminate when some do, empty when none do. Clicking an empty or indeterminate box checks it (add to all); clicking a checked box empties it (remove from all). Untouched rows keep each bookmark's current state. **Apply** writes all changes in one `updateBookmarks` call. Typing a name that matches no tag (case-insensitive) offers "Create «name»", validated like A's tag dialog; a tag blocked by the quota is not added. | Selection stays |
| Favorite | Unfavorites all selected bookmarks if every one is a favorite; otherwise favorites all of them. The button label follows ("Favorite" / "Unfavorite"). | Selection stays |
| Archive | `archiveBookmarks`, no confirmation. | Notice "Archived N bookmarks" with a link to the Archive page; selection clears |
| Delete | `trashBookmarks`, no confirmation. | Notice "Moved N bookmarks to Trash" with a link to the Trash page; selection clears |
| Open all in new tabs | Opens the selected URLs in view order as background tabs in the current window. More than 10 asks first ("Open 37 tabs?"). | Selection stays |
| Open as a tab group | Same tabs and confirmation, then groups them. The group title is the shared collection's name when all selected bookmarks are in one collection, otherwise the active workspace's name. | Selection stays |
| Copy links | Writes the URLs in view order, one per line, to the clipboard. | Notice "Copied N links" |
| Copy as Markdown list | One line per bookmark: `- [title](url)`, with `\`, `[` and `]` in titles escaped, line breaks in titles replaced with spaces, and spaces, `(` and `)` in URLs percent-encoded. | Notice "Copied N links" |

**Notices** use the floating `Alert` pattern from `CLAUDE.md` with `role="status"` and disappear after 3 seconds. Notices that contain a link accept pointer events.

### 3. Unified bookmark form

**Components.**

- `components/dashboard/shared/bookmark-form.tsx` — `BookmarkForm`, the form body without a container.
- `components/dashboard/shared/bookmark-dialog.tsx` — `BookmarkDialog`, a standard shadcn dialog around the form, with `mode: "add" | "edit"`.
- `components/dashboard/shared/collection-picker.tsx` — the searchable collection list with "New collection…", shared by the form and the bulk Move menu.
- `components/dashboard/shared/tag-picker.tsx` — the form's chip-based tag picker. The bulk Tags menu has its own three-state list.

**Opening.** Following the existing global dialog pattern, `WorkspaceRail` mounts one `BookmarkDialog` and listens for the window event `tabslate-open-bookmark`. Callers use a typed helper in `lib/bookmark-dialog-events.ts`:

```ts
openBookmarkDialog({ bookmarkId?: string; focus?: "tags" | "notes" })
```

Without `bookmarkId` the dialog opens in add mode. The callers are the header's "Add bookmark" button, the bookmark menu's "Edit…" (`{ bookmarkId }`) and "Add tags" (`{ bookmarkId, focus: "tags" }`), and the notes popover's "Edit note" (`{ bookmarkId, focus: "notes" }`). An edit request for a bookmark that is no longer active does not open the dialog.

**Replaced.** `AddBookmarkDialog`, `EditBookmarkDialog`, and `BookmarkTagsDialog` are deleted. `BookmarkCard` loses its `onEdit` and `onAddTags` props, and `BookmarksContent` loses its `editingBookmark` and `taggingBookmark` state. As a side effect, "Edit" and "Add tags" start working on the Favorites page, where they currently do nothing.

**Fields.**

| Field | Behavior |
|---|---|
| Title | Required. |
| URL | Required. If the input contains no `://`, `https://` is prepended; the result must be accepted by `new URL()`. In add mode A's duplicate notice runs as before. In edit mode it runs only after the URL is changed and excludes the bookmark being edited. |
| Description | Single line, as today. |
| Notes | Multi-line, grows with its content, `maxLength` 10,000. A counter appears above 9,000 characters. Leading and trailing whitespace is trimmed on save. |
| Collection | The collection picker. Add mode preselects the collection being viewed (route `/` with an active collection selected), otherwise the workspace's default collection. Edit mode shows the bookmark's collection; an uncategorized bookmark shows "Uncategorized" until another collection is picked. |
| Tags | Selected tags as removable chips plus a filter input. Enter picks the highlighted tag; when no tag matches the typed name (case-insensitive) it offers "Create «name»", validated like A's tag dialog. Backspace in an empty input removes the last chip. A tag blocked by the quota shows the existing quota alert and is not added. |

**Interaction.**

- The form uses `onSubmit` with inline errors (the `CLAUDE.md` rule for forms that show errors).
- Cmd/Ctrl+Enter saves from any field; Enter in the notes field inserts a line break.
- `focus: "tags"` or `focus: "notes"` places the cursor in that field when the dialog opens.
- Edit mode shows a muted footer line: "Added «date» · Updated «date»" (the second part only when an edit time exists), formatted for the current language.

**Saving.**

- **Add** resolves the target collection with `resolveActiveWorkspaceCollectionTarget` as today and calls `addBookmark` with the notes. A duplicate notice never blocks saving.
- **Edit** compares the form with the stored bookmark. With no changes the dialog closes without writing, so the edit time does not change. If the bookmark is no longer active (archived or deleted on another device meanwhile), the form shows "This bookmark was changed on another device" and writes nothing. Otherwise it calls `updateBookmark` with the changed fields only.

**Popup.** The save popup gets a collapsed "Add note" link that expands into a notes field (same 10,000 limit). The note travels in the `ADD_BOOKMARK` message and in the storage fallback (`lib/storage.ts`).

### 4. Notes

**Client data.** `Bookmark` gains `notes?: string`. A missing value means `""`, so existing IndexedDB records need no migration.

- `toServerBookmark` always sends `notes`.
- The sync confirmation comparisons (`entityMatchesBookmark` in `store/bookmarks-store.ts` and the record comparison in `lib/sync-confirmation.ts`) compare notes, treating a missing value as `""`.
- `mergeFromServer` uses `serverBookmark.notes ?? existing?.notes ?? ""`, so a server that returns no notes never clears local notes.
- `applySearch` in the bookmarks store also matches notes.
- The limit lives in one constant, `MAX_BOOKMARK_NOTES_LENGTH = 10_000` (UTF-16 code units, the unit `maxLength` counts).

**Display.** A card with notes (grid and list) shows a notes icon button labeled "Show notes". It opens a popover with the full note:

- line breaks are kept and long notes scroll;
- `http://` and `https://` links become `<a target="_blank" rel="noopener noreferrer">` elements, with trailing punctuation (`.,;:!?)`) left outside the link. The text is rendered as React text and elements, never as HTML (`lib/linkify.ts`);
- an "Edit note" button opens the form with the cursor in the notes field.

Clicks on the icon and inside the popover stop propagation, so they neither open the bookmark nor change the selection.

**Server.** See section 7. Pushes without a `notes` field keep the stored notes, and the search index always uses the stored notes.

**Firefox.** Notes are sent only with the existing account-data consent and are filed under `websiteContent`, like descriptions. The comment on `FIREFOX_ACCOUNT_DATA_COLLECTION` and the Firefox bullet in `CLAUDE.md` mention notes; the declared categories do not change.

### 5. Edit time and sorting

**Client data.** `Bookmark` gains `updatedAt?: number`, the Unix ms time of the user's last change.

- Every local user change stamps it with `Date.now()`: adding (all add paths, including imports, the popup storage fallback, and the background's IndexedDB fallback), editing, moving, tag changes, favoriting, archiving, deleting, and restoring.
- Re-pushes, sweeps, and sync confirmations never change it.
- `toServerBookmark` sends `edited_at: updatedAt ?? Date.parse(createdAt)`, so legacy records report their creation time.
- `mergeFromServer` uses `serverBookmark.edited_at ?? serverBookmark.updated_at ?? existing?.updatedAt`. A server without `edited_at` falls back to its `updated_at`.
- The sync confirmation comparisons include `edited_at`, so an older push cannot confirm a newer local edit.
- Bookmarks without `updatedAt` sort by `createdAt`.

**Sort orders.** `SortBy` (A's `BookmarkSortBy` in `lib/view-preferences.ts`) gains three values. A's parser already maps values an older client does not know to the default.

| Value | Order |
|---|---|
| `updated-newest` / `updated-oldest` | `updatedAt ?? Date.parse(createdAt)`, then ID, so the order is stable across reloads |
| `site-az` | Host name lowercased without a leading `www.`, then title, then ID. URLs that cannot be parsed sort last. Subdomains are separate sites (no public suffix list). |

The main list and the Favorites page use the current sort; the Archive and Trash pages keep their fixed order. The host key comes from a `siteSortKey(url)` helper in A's `lib/url-match.ts`.

**Header.** The sort button currently shows the first word of the option's label, which cannot tell "Date added" from "Date updated". Each option gets a short button label (for example "Added ↓", "Updated ↓", "A–Z", "Site").

### 6. Sync push size

The server answers 413 to a push with more than 1,000 entities or a body larger than 512 KB, and the extension does not retry a 413. `splitSyncPushPayload` in `lib/sync-recovery.ts` splits only by entity count (900). Bulk edits and notes make the byte limit easy to reach; 20 bookmarks with long Chinese notes already exceed it.

`splitSyncPushPayload` therefore also limits each chunk to `MAX_SYNC_PUSH_BYTES = 384 * 1024`, measured as the UTF-8 length of each entity's JSON plus one byte per separator, and keeps the current order (non-bookmark entities before bookmarks). Notes add at most about 60 KB of JSON to a bookmark (10,000 characters, escaped), so ordinary bookmarks always fit. An entity that exceeds the chunk limit on its own (only possible with an extremely long URL, title, or description) is sent in a chunk by itself, and if the server still rejects it, the existing error handling applies. This also removes the existing risk of an oversized push when a large library syncs for the first time.

### 7. Server and Cloud changes

**TabSlate-server.**

- **Schema** (`db/schema.pg.sql`, idempotent):

  ```sql
  ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';
  ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS edited_at BIGINT;
  ```

- **Model** (`internal/model/model.go`): `Bookmark` gains `Notes *string json:"notes,omitempty"` and `EditedAt *int64 json:"edited_at,omitempty"`. A nil pointer means the client did not send the field. `BookmarkRequest` gains `Notes *string json:"notes" binding:"omitempty,max=10000"`.
- **Sync push** (`internal/handler/sync.go`):
  - A bookmark whose notes exceed 10,000 characters (runes) is rejected with reason `invalid_field`. The extension's limit counts UTF-16 units, which is never more than the rune count, so this only stops malformed clients.
  - Insert: `notes = COALESCE($notes, '')`, `edited_at = COALESCE($edited_at, $now)`.
  - Update: `notes = COALESCE($notes, bookmarks.notes)`, `edited_at = COALESCE($edited_at, $now)`, under the existing `updated_at < $now` condition.
  - The upsert ends with `RETURNING notes`. No returned row means the existing stale rejection; otherwise the search document is built from the returned notes, so a push from an older extension never blanks the indexed notes.
- **Sync pull** selects and returns `notes` and `edited_at`.
- **REST** (`internal/handler/bookmarks.go`): reads return both fields; create stores `COALESCE($notes, '')`; update keeps the stored notes when the field is absent; both set `edited_at` to the server time. Search indexing after REST writes also uses the stored notes.
- **Search** (`internal/search`): `BookmarkDoc` gains `Notes string json:"notes"`, and `notes` is appended to the searchable attributes after title, URL, and description. Search results do not return notes.

**TabSlate-cloud.** Bump the TabSlate-server module and run the test suite. No code changes are expected; the only bookmark-related cloud code is the Flexprice quota provider.

**Compatibility.**

| Combination | Behavior |
|---|---|
| New extension, old server | The server ignores the unknown fields. Notes and edit times stay on the device that wrote them; pulls never clear them. |
| Old extension, new server | Its pushes omit `notes` and `edited_at`: notes are kept, and the edit time becomes the server time of the push. It does not show notes. |
| New extension, new server | Notes and edit times sync. |

**Deployment order.** TabSlate-server first, then TabSlate-cloud, then the extension. The extension also works against servers that have not been updated.

## Components and Files

Frontend, new:

- `store/selection-store.ts`
- `components/dashboard/bulk-actions/` — the bulk bar, the Move and Tags menus, the open-tabs confirmation, and the notice
- `components/dashboard/shared/bookmark-form.tsx`, `bookmark-dialog.tsx`, `collection-picker.tsx`, `tag-picker.tsx`, `bookmark-notes-popover.tsx`
- `lib/bookmark-dialog-events.ts`, `lib/linkify.ts`, `lib/bookmark-clipboard.ts` (plain and Markdown link lists)

Frontend, modified:

- `lib/types.ts` (`notes`, `updatedAt`), `lib/bookmark-utils.ts` (`MAX_BOOKMARK_NOTES_LENGTH`), `lib/url-match.ts` (`siteSortKey`), `lib/view-preferences.ts` (sort values)
- `store/bookmarks-store.ts` — batch actions, edit-time stamping, notes and `edited_at` in push, merge and confirmation, sort orders, notes search
- `lib/sync-recovery.ts` (byte-limited chunks), `lib/sync-confirmation.ts`, `lib/storage.ts` (popup fallback), `lib/chrome/tabs.ts` (open in background, open as a group)
- `components/dashboard/content.tsx`, `favorites-content.tsx`, `bookmark-card.tsx`, `header.tsx`, `workspace-rail.tsx`, `shared/bookmark-menu-items.tsx` (from A)
- `entrypoints/popup/App.tsx`, `entrypoints/background.ts` (edit time in the IndexedDB fallback)
- `lib/browser/data-collection-permissions.ts` (comment), both `messages.json`, `CLAUDE.md`, `ARCHITECTURE.md`

Frontend, deleted: `components/dashboard/add-bookmark-dialog.tsx`, `components/dashboard/shared/edit-bookmark-dialog.tsx`, `components/dashboard/shared/bookmark-tags-dialog.tsx`. Their tests move to the new form's tests.

TabSlate-server: `db/schema.pg.sql`, `internal/model/model.go`, `internal/handler/sync.go`, `internal/handler/bookmarks.go`, `internal/search/types.go`, `internal/search/client.go`, their tests, and the server's `CLAUDE.md` and `ARCHITECTURE.md`.

TabSlate-cloud: `go.mod`, `go.sum`.

## Error Handling

- **Bulk actions** skip bookmarks that are no longer active. A retired Move target writes nothing and shows the "target unavailable" notice. A clipboard or tab-opening failure shows a notice and changes nothing else. A tag or collection created from a menu goes through the existing quota guard.
- **Form.** Validation errors are inline. Saving an edit of a bookmark that is no longer active writes nothing and says so. A blocked new tag is not added.
- **Server.** Over-long notes are rejected per bookmark with `invalid_field`, which the extension reports through its generic rejection path. Absent fields keep stored values.
- **Sync.** Byte-limited chunks keep pushes under the server's body limit; existing retry and recovery behavior is unchanged.

## Testing

Each behavior is implemented test-first, with the happy-dom helpers and module save-and-restore pattern from A.

- **Frontend unit tests:** the selection store (toggle, range with and without an anchor, set many, retain, clear); the batch actions (counts, `_archivedLoaded` and `_trashedLoaded` rules, a single IndexedDB transaction and enqueue, edit-time stamping, dropped no-op patches, usage moved to trash); tri-state tag computation and the resulting patches; plain and Markdown link formatting and escaping; linkify; the `updated-*` and `site-az` orders; byte-limited push splitting; `toServerBookmark`, `mergeFromServer`, and the confirmation comparisons with notes and `edited_at`, including the old-server fallbacks; the new view-preference values.
- **Frontend component tests:** card checkbox, click, Shift and Cmd/Ctrl behavior; Esc handling; group header checkbox; each bulk bar action and notice; the form in add and edit mode (validation, URL rule, collection default, tag create and reuse, Cmd/Ctrl+Enter, no-op save, removed bookmark, duplicate notice); the notes popover (links, no propagation); Favorites edit and tag actions; header short sort labels.
- **Server tests** (Go, in the existing handler test style): push keeps notes when the field is absent and stores them when present, including an empty string; over-long notes are rejected; `edited_at` uses the client value or the server time; pull and REST return both fields; REST update keeps absent notes; search documents carry the stored notes; the schema migration runs twice without error.
- **Cloud:** `go test ./...` after the module bump.
- **Manual check:** two signed-in browser profiles; bulk actions on several hundred bookmarks; notes created in the popup and in the form; "Date updated" order after a guest signs in; an extension build from before this change pushing an edit without deleting notes.

## Accessibility and Internationalization

- Card checkboxes are buttons with `role="checkbox"`, `aria-checked`, and an `aria-label` of "Select «title»". The group header checkbox exposes the mixed state.
- The bulk bar is `role="toolbar"` with its own label, and the selected count is announced through an `aria-live="polite"` region.
- The notes button has an accessible label, and the popover returns focus to it when closed.
- Every new string is translated in English and Simplified Chinese with `[component]_[description]` keys.

## Resolved During Design

- **Edit time source.** The server's `updated_at` records when a push arrived, so a guest's first sync after signing in, and recovery re-pushes, would mark every bookmark as just updated. A separate client-reported `edited_at` column keeps "Date updated" meaningful; `updated_at` keeps its conflict role.
- **Firefox declaration.** Notes go under `websiteContent` with descriptions. Adding a new category to the account consent would make existing users fail the consent check and stop syncing until they agreed again.
- **Tab groups on Firefox.** `supportsTabGroups()` is already true for the Firefox build (minimum version 142), so "Open as a tab group" is offered on both browsers.
