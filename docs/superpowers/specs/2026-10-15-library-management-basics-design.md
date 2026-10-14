# Library Management Basics (Sub-project A)

## Summary

A comparison with faved.to showed that TabSlate's bookmark library lacks several everyday management basics: view and sort choices reset on every new tab, tags and collections cannot be renamed or recolored from the UI, the sidebar shows no tag counts and has no tag search, tags on cards are not clickable, there is no keyboard shortcut for saving the current page, and duplicate detection only runs when tabs are dragged into a collection.

This sub-project closes those gaps in the frontend only. It syncs view preferences across devices through the existing `/preferences` endpoint, turns the sidebar tag chips into a managed surface (counts, search, right-click menu), adds right-click menus to collection rows and bookmark cards, makes card tags clickable filters, adds a save shortcut, and runs duplicate detection at every save entry point with two matching tiers: a strict tier that blocks and a loose tier that warns.

## Roadmap Context

This is the first of five sub-projects derived from the faved.to comparison. Each has its own spec, plan, and implementation cycle:

| Sub-project | Scope | Repositories |
|---|---|---|
| **A — Library management basics** (this spec) | View preferences, tag and collection editing, counts, tag search, clickable tags, save shortcut, duplicate detection | Frontend |
| B — Bulk operations and unified form | Multi-select with a bulk action bar, unified add/edit form, notes and updated-at fields, more sort options | Frontend + server |
| C — Page snapshots and image view | Server-side preview images, metadata refetch, AI summary, archived page content, small-card and image-card views | Server + cloud + frontend |
| D — Nested tags and import hierarchy | Tag hierarchy, parent rollups, folder hierarchy preserved on import | Frontend + server |
| E — Onboarding | Seed content and guided first-run steps | Frontend |

## Goals

- Remember the bookmark view mode and sort order, synced across signed-in devices.
- Let users rename, recolor, and delete tags, and edit collection names and icons, from the sidebar.
- Show per-tag bookmark counts and let users search the tag list.
- Offer the same menu on right-click as on the existing ⋯ buttons for collections and bookmark cards; tags use right-click only.
- Let users filter by a tag by clicking it on a bookmark card.
- Provide a default keyboard shortcut that opens the save popup.
- Warn about duplicates when saving manually, while still allowing the save; keep blocking duplicates for drag-and-drop and batch tab saves.

## Non-goals

- Server, cloud, or sync protocol changes.
- An undo toast system. Destructive tag deletion uses a confirmation dialog.
- Tag hierarchy or nested collections (sub-project D).
- Duplicate checks against archived or trashed bookmarks.
- Changing duplicate-name rules for collections.
- Syncing filter state (favorites/with-tags/without-tags), selected collection, or selected tags.
- Live propagation of view preferences to already-open tabs.

## Decisions

| Question | Decision |
|---|---|
| Duplicate handling for manual saves | Warn and allow "save anyway". Drag-and-drop and batch saves keep skipping duplicates. Context-menu saves skip duplicates and show feedback. |
| View preference persistence | Sync view mode and sort across devices through `/preferences`; guests keep them locally. Filters are not persisted. |
| Sidebar tag layout | Enhanced chips (current chip cloud with counts), no ⋯ button on chips. |
| Tag management entry point | Right-click context menu on chips. |
| Right-click scope | Tags (right-click only), collection rows and bookmark cards (right-click in addition to the existing ⋯). |
| Implementation approach | Keep state where it lives today and add small focused modules (`view-preferences`, `url-match`, `context-menu`); match duplicates in memory. |

## Design

### 1. View preferences

**State location.** `viewMode` (`"grid" | "list"`) and `sortBy` (`"date-newest" | "date-oldest" | "alpha-az" | "alpha-za"`) stay in `useBookmarksStore`. Components keep their current selectors.

**Storage.**

- Local copy: IndexedDB `kv` key `bookmark-view-prefs`, value `{ viewMode, sortBy, updatedAt, dirty }`. `updatedAt` is Unix ms; `dirty` means the local value has not been pushed.
- Server copy: key `bookmarkView` inside the opaque `/preferences` JSON object, value `{ viewMode, sortBy, updatedAt }`.
- `lib/view-preferences.ts` owns the types, validation, local read/write, and the server read-merge-write. Validation maps any unknown or missing value to the defaults (`grid`, `date-newest`). This keeps older and newer clients compatible when sub-project C changes the view modes.

**Lifecycle.**

1. **Hydrate.** `useSettingsStore.hydrate()` reads the local copy and applies it to the bookmarks store before setting `_hydrated`. `StoreGate` already waits for the settings store, so the dashboard never renders with the default view first.
2. **Local change.** The settings store subscribes to the bookmarks store's `viewMode` and `sortBy`. On a user change it writes the local copy with `updatedAt = now` and `dirty = true`, then schedules a push debounced by 1 s. Values applied from the server do not count as user changes and never trigger a push.
3. **Push.** `GET /preferences`, replace only `bookmarkView`, `PUT /preferences` with the merged object. On success clear `dirty`, unless the local copy changed again while the request was in flight.
4. **Pull.** `useSettingsStore.pullFromServer(serverUrl, accessToken)`, already called by `App.tsx` once the sync session is eligible, reads `bookmarkView` and compares `updatedAt`:
   - server newer, or no local copy: apply the server value and store it locally with `dirty = false`;
   - local newer, or local `dirty`: push the local value;
   - equal: no-op.
5. **Session reset.** Logout clears IndexedDB, so the local copy resets to defaults; the values currently shown in the open page are left as they are. `useSettingsStore.reset()` clears the pending push and in-memory bookkeeping.

**Eligibility.** Pushes and pulls use the same gate as `SyncProvider`: verified user, access token, server URL, and, on Firefox, account-data consent. Guest, unverified, and offline sessions only use the local copy.

**Propagation.** Each new tab is a new page that pulls on start, so a change on one device reaches the others the next time they open a new tab. Open tabs do not update live.

### 2. Sidebar tags section

The section keeps the current chip cloud and the current tag order.

- **Counts.** Each chip shows `name count`. The count is the number of active bookmarks in the active workspace that carry the tag, using the same visibility rule as `getFilteredBookmarks` (bookmarks in the workspace's active collections plus uncategorized bookmarks). Chips with a count of 0 render the number muted but stay visible so they can still be managed.
- **Selection.** Clicking a chip toggles it in `selectedTags`, as today. The selected style is unchanged. Chips are buttons with `aria-pressed`.
- **Removed.** The hover × that hard-deletes a tag in one click is removed. Deletion moves to the context menu with a confirmation.
- **Hint.** Hovering a chip for 1 s shows a tooltip, "Right-click to edit", using the existing `Tooltip` component.
- **Search.** A search icon in the section header replaces the header row with an input. Typing filters chips by a case-insensitive substring match on the name and highlights the matched text. Esc or the × button closes the input and clears the query. Searching changes only what the sidebar shows; it never changes `selectedTags`.

### 3. Context menus and edit entry points

**Shared building blocks.**

- Add `components/ui/context-menu.tsx`, the standard shadcn component built on the Radix ContextMenu shipped in the existing `radix-ui` dependency.
- Menu items are defined once per entity (tag, collection, bookmark) as components that receive a set of menu primitives (item, separator, sub-menu trigger and content). Two primitive sets exist, one backed by `DropdownMenu` and one by `ContextMenu`, so the ⋯ menu and the right-click menu render the same items.
- Keyboard users can open a context menu on a focused element with Shift+F10 or the menu key.

**Tag menu** (right-click on a sidebar chip):

- **Rename…** opens `TagDialog` in edit mode (name and color prefilled). `TagDialog` gains an optional `initial` tag, like `CollectionDialog`.
- **Color ▸** is a sub-menu of the `TAG_COLORS` swatches. Selecting one calls `updateTag(id, { color })` immediately; the current color shows a check.
- **Delete…** opens a confirmation dialog: the tag will be removed from N bookmarks and this can't be undone. N counts active bookmarks in all workspaces, because tags are global. Confirming calls the existing `deleteTag`, which keeps its current semantics (tag tombstone only; dangling tag IDs on bookmarks are already ignored when rendering).

**Tag name validation** (create and rename): the trimmed name must be non-empty and must not equal another tag's name case-insensitively. Violations show an inline error and do not submit. This also tightens tag creation, which currently accepts duplicates.

**Collection menu** (⋯ and right-click on a sidebar collection row):

- **Edit…** opens `CollectionDialog` in its existing edit mode and calls `updateCollection(id, { name, icon })`. Both actions already exist; this only wires them to the UI.
- **Archive** and **Delete** stay as they are.
- The default collection, which has no menu today, gets **Edit…** only. It cannot be archived or deleted.
- The "All bookmarks" row has no menu.

**Bookmark card menu** (right-click wherever `BookmarkCard` renders an active bookmark, grid and list variants): the same items as the existing ⋯ menu, with no new items. Dragging uses the primary button only, so right-click does not conflict with drag-and-drop. Archive and trash views, which use their own card components, are unchanged.

**Strings.** All new strings use `t()` with keys in both `messages.json` files. The hard-coded English titles in `TagDialog` and `CollectionDialog` move to translation keys.

### 4. Clickable tags on bookmark cards

`TagList` gains optional `onTagClick(tagId)` and `selectedTagIds` props. When provided, tags render as buttons with `aria-pressed`. `BookmarkCard` passes the bookmarks store's `toggleTag`, so clicking a card tag adds or removes it from the tag filter exactly like the sidebar. The click stops propagation so the bookmark is not opened. The `+N` overflow indicator is not interactive. Other `TagList` usages are unchanged because the props are optional.

### 5. Duplicate detection

**Matching tiers** (`lib/url-match.ts`):

| | Strict tier (blocking) | Loose tier (warning) |
|---|---|---|
| Normalization | Lowercase scheme and host; drop the default port; drop one trailing `/` from the path | Strict tier, plus: treat `http` and `https` as equal; drop a leading `www.` |
| Kept as-is | Path, query, and fragment, including their case | Path and query values, including their case |
| Ignored | Nothing else | The fragment; tracking parameters `utm_*`, `fbclid`, `gclid`, `dclid`, `msclkid`, `mc_cid`, `mc_eid`, `igshid`, `yclid`, `_hsenc`, `_hsmi` |

- Strings that cannot be parsed as URLs are compared as trimmed raw text and never throw.
- The module exposes `strictUrlKey(url)`, `looseUrlKey(url)`, and `findUrlMatches(url, bookmarks, tier)`.
- The existing helpers in `lib/bookmark-utils.ts` (`normalizeUrl`, `findDuplicateBookmark`, `getNormalizedUrlSet`) switch to the strict tier. This fixes the current behavior of lowercasing the whole URL, which treats case-sensitive links (short links, YouTube IDs, GitHub paths) as duplicates. A separate standalone task tracks the same fix; whichever lands first, the other reuses it.

**Visibility.** Matches only include active bookmarks whose collection is active and whose workspace is active, plus uncategorized bookmarks. Bookmarks under a retained (deleted) workspace or an archived or trashed collection are never matched or shown, consistent with the workspace lifecycle rules. The existing helpers in `lib/workspace-visibility.ts` decide this. A match's location label is «collection» · «workspace»; an uncategorized bookmark is labeled "Uncategorized".

**Entry points.**

- **Add bookmark dialog (newtab).** After the URL changes (300 ms debounce), run the loose tier against visible bookmarks in all workspaces. On a match, show a notice under the URL field: "Already saved in «collection» · «workspace»", or "…and N more" for several matches. The notice has an **Open existing bookmark** action that closes the dialog, switches to the bookmark's workspace and collection (or "All bookmarks" when it is uncategorized), clears the selected tags, the filter type, and the search query, and sets `highlightedBookmarkId`. The existing list logic then scrolls to the bookmark and flashes it. The save button stays enabled.
- **Popup.** On open, read bookmarks, collections, and workspaces from IndexedDB (through `lib/storage.ts`) and run the loose tier against the current tab URL. On a match, show the same notice at the top and relabel the save button **Save anyway**. **Open existing bookmark** opens or focuses TabSlate with `#/?highlight=<bookmarkId>`.
- **Deep link.** The newtab reads `highlight` from the hash query once. If the bookmark is visible it applies the same navigation as the add dialog's action, then removes the parameter with a replace navigation. An unknown or hidden ID is ignored and the parameter is still removed.
- **Context menu (background).** No UI is available to ask, so run the strict tier against visible bookmarks in the active workspace (`kv.activeWorkspaceId`). A duplicate is not saved and the action badge for that tab shows an amber, translated "Saved" (已存) for 3 s. A successful save, which today gives no feedback, shows a green "✓" for 3 s. The background has no access to the in-app language override, so the badge text uses the browser locale through `browser.i18n.getMessage`. Badges need no new permission.
- **Drag-and-drop and batch tab saves.** Keep skipping duplicates in the active workspace, now using the strict tier.

### 6. Save shortcut

- `wxt.config.ts` adds the special `_execute_action` command with a suggested key that opens the popup:
  - Chromium builds: `Ctrl+Shift+S`, macOS `Command+Shift+S`;
  - Firefox build: `Alt+Shift+S`, because Firefox already uses `Ctrl+Shift+S` for screenshots.
- Users can rebind it in the browser's extension shortcut settings.
- The popup footer shows the currently bound shortcut, read with `commands.getAll()`, so a rebound key displays correctly. If no key is bound, the footer explains where to set one.

## Components and Files

New:

- `lib/view-preferences.ts` — types, validation, local and server read/write for view preferences.
- `lib/url-match.ts` — strict and loose URL keys and match lookup.
- `components/ui/context-menu.tsx` — shadcn context menu.
- `components/dashboard/shared/` — menu primitives, per-entity menu items (tag, collection, bookmark), tag delete confirmation dialog, duplicate notice.

Modified:

- `store/settings-store.ts` — hydrate, subscription, debounced push, pull with last-write-wins.
- `components/dashboard/sidebar/index.tsx`, `sidebar/tag-dialog.tsx`, `sidebar/collection-dialog.tsx` — counts, search, menus, edit modes, validation, i18n.
- `components/dashboard/bookmark-card.tsx`, `components/ui/tag-list.tsx` — right-click menu, clickable tags.
- `components/dashboard/add-bookmark-dialog.tsx`, `components/dashboard/content.tsx` — duplicate notice, open-existing navigation, deep-link handling.
- `entrypoints/popup/App.tsx`, `lib/storage.ts` — duplicate notice, Save anyway, shortcut hint.
- `entrypoints/background.ts` — strict duplicate check and badges for context-menu saves.
- `lib/bookmark-utils.ts` — strict-tier helpers.
- `wxt.config.ts`, `test/wxt-config.test.ts` — save shortcut per browser.
- `public/_locales/en/messages.json`, `public/_locales/zh_CN/messages.json` — new strings.
- `CLAUDE.md`, `ARCHITECTURE.md` — the new `kv` key, the `bookmarkView` preference, the URL-matching tiers, and the deep-link parameter.

## Error Handling

- **View preference sync.** Network errors, 401, and missing Firefox consent are silent; `dirty` stays set and the push retries on the next change or pull.
- **Duplicate lookup.** If the popup or background cannot read IndexedDB, the lookup reports no match and saving continues normally. A failed check must never block a save. The failure is logged.
- **Tag deletion race.** If another device deletes the tag while the confirmation is open, confirming is a silent no-op.
- **Deep link.** An unknown or hidden bookmark ID is ignored and the parameter is removed.
- **Badges.** Failures to set or clear a badge are ignored and never affect the save result.

## Testing

Each behavior is implemented test-first.

- **Unit tests.**
  - `url-match`: table-driven cases for host case, default ports, trailing slash, case-sensitive paths and queries (short links), fragments, tracking parameters, `www.`, `http` versus `https`, and unparsable input.
  - `view-preferences`: invalid values fall back to defaults; each last-write-wins branch (server newer, local newer or dirty, equal); the merged push preserves other keys.
  - Background context-menu save: the duplicate decision and badge outcome extracted as a pure function.
- **Component tests** (happy-dom, using the module save-and-restore pattern from `test/bookmarks-header-subscription.test.tsx` so no test leaks mocks into later files):
  - tag chip counts and search highlighting;
  - the three tag menu actions and the N shown in the delete confirmation;
  - clicking a card tag changes the filter without opening the bookmark;
  - the add dialog's duplicate notice and the open-existing navigation.
- **Manifest test.** `test/wxt-config.test.ts` asserts the suggested shortcut for the Chromium and Firefox builds.
- **Manual check.** Load the unpacked build in Chrome and Firefox; verify the shortcut, the context-menu badges, popup duplicate notice and deep link, and that view preferences follow the user to a second signed-in profile.

## Accessibility and Internationalization

- Tag chips and clickable card tags are buttons with `aria-pressed` reflecting selection.
- The tag search input has an accessible label.
- Context menus open from the keyboard with Shift+F10 or the menu key.
- The confirmation dialog uses Radix's default focus management.
- Every new string is translated in English and Simplified Chinese, using `[component]_[description]` keys.

## Review Items for Implementation

- **Firefox data-collection declaration.** `/preferences` sync only runs after account-data consent. Confirm against Mozilla's category definitions that syncing a UI preference needs no new category in `lib/browser/data-collection-permissions.ts`; add one to `optional` if it does.
- **Settings store imports.** The settings store will read auth state and consent. Check that this adds no import cycle with the auth store; if it does, pass an eligibility callback from `App.tsx` instead.
- **Popup tag creation.** The tag-name rule is enforced in `TagDialog`. Confirm that the popup's quick tag input reuses an existing tag with the same name (case-insensitive) instead of creating a duplicate; if it does not, apply the same rule there.
