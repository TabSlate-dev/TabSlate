# Search Syntax and Smart Collections (Sub-project G)

## Summary

TabSlate's header search filters the current list by a plain substring of the title, URL, description, or notes. The new tab page's search box shows bookmark results only from server search, so guests and offline users get none. Neither can express "favorites tagged design from github.com added this month".

This sub-project adds a search syntax modeled on Karakeep's: qualifiers such as `#tag`, `in:collection`, `site:`, `is:fav`, `has:notes`, and date ranges, combined with negation, `or`, and parentheses. Both search boxes use it, and the new tab search box gains local results. It also adds smart collections, saved queries listed in the sidebar. They are global like tags and sync as their own entity.

## Roadmap Context

The faved.to comparison (see `docs/superpowers/specs/2026-10-15-library-management-basics-design.md`) produced sub-projects A to E; a review against that comparison and Karakeep added F, G, and H.

| Sub-project | Scope | Repositories |
|---|---|---|
| A — Library management basics | View preferences, tag and collection editing, counts, tag search, clickable tags, save shortcut, duplicate detection | Frontend |
| B — Bulk operations and unified form | Multi-select and bulk bar, unified add/edit form, notes, edit time, more sort options | Frontend + server |
| C1 — Image card view | Small and large card views, `og:image` covers, "Fetch details" in the form | Frontend + server (one field) |
| C2 — Web snapshots | Server and browser page capture, snapshot viewer, full-page archives, possibly broken links, storage quota | Server + cloud + frontend |
| D — Nested tags and import hierarchy | Tag hierarchy, tag tree, folder hierarchy on import, merging and cleaning up tags | Frontend + server |
| E — Onboarding | First-run checklist | Frontend |
| F — Export, restore, and imports | JSON and HTML export, restore, snapshot zip, nine new import sources | Frontend + server |
| **G — Search syntax and smart collections** (this spec) | Query syntax in both search boxes, local results in the new tab search box, smart collections | Frontend + server |
| H — Local AI tagging and summaries | AI features using the user's own endpoint and key, stored only on the device | Frontend |

**Depends on B and D.** `updated:` uses B's edit time, and tag qualifiers use D's paths and descendants. `has:cover` uses C1's covers, and `has:snapshot` and `is:broken` use C2's snapshots; without them those qualifiers match nothing. F's Karakeep import converts smart lists once G exists.

## Goals

- Let users narrow any bookmark list with qualifiers, negation, and alternatives.
- Make the new tab search box find bookmarks for guests and offline users.
- Save queries as smart collections that follow the user across devices.
- Keep everything instant and local; server search only adds typo-tolerant and snapshot-text matches.

## Non-goals

- The syntax in the search overlay on web pages, which keeps its plain-text server search.
- Evaluating queries on the server.
- Bookmark counts for smart collections in the sidebar.
- Archived or trashed bookmarks in smart collections; they show active bookmarks, like the main list.
- Smart collections scoped to a workspace, shared smart collections, and manual ordering.
- Saving highlighted matches or ranking results by relevance in the lists.

## Decisions

| Question | Decision |
|---|---|
| Syntax | Karakeep-style qualifiers adapted to TabSlate's data, with `-`/`!` negation, `or`, parentheses, and quotes. |
| Where | The header search (main list, Favorites, Archive, Trash) and the new tab search box. The web-page overlay is unchanged. |
| New tab search box | Local results with the syntax first, then server results not already listed. |
| Smart collection scope | Global, like tags; results always come from the active workspace. |
| Smart collection sync | A new sync entity with last-write-wins, gated by a server capability. |
| Limit | 100 smart collections per user. |

## Design

### 1. Where the syntax applies

- **Header search** (`components/dashboard/header.tsx`): the main list, Favorites, Archive, and Trash all filter with the parsed query, replacing `applySearch`'s substring match. The placeholder becomes a translated hint such as "Search, or try #tag, site:…".
  - The header's search input is currently commented out in `header.tsx`, so nothing sets the store's `searchQuery` and these lists cannot be searched today. This sub-project restores the input, with a translated placeholder and an accessible label, and shows it at every width rather than only from `md` up.
- **New tab search box** (`components/dashboard/search-box.tsx`). The dropdown lists:
  1. Open tabs, matched on the query's plain text only.
  2. Local bookmark results, matched with the full syntax against the active workspace's visible bookmarks (and the `collectionId` prop when set). This is new and works for guests and offline.
  3. Server results (signed-in users, as today) for bookmarks not already listed. They add typo-tolerant matches and, with C2, matches in snapshot text with a snippet. A query that contains qualifiers sends only its plain text to the server, and server results are then filtered locally with the full query.
  4. The web search fallback, with the raw input, as today.
- **Search overlay** on web pages: unchanged.

### 2. Grammar

| Input | Meaning |
|---|---|
| Space-separated terms | All must match (AND). |
| `or`, `OR` | Either side matches. AND binds tighter than OR. |
| `( … )` | Grouping. |
| `-` or `!` before a term or group | Negation. |
| `"…"` | A value or phrase containing spaces. |
| Plain words | Each word must appear in the title, URL, description, or notes, case-insensitively. A quoted phrase must appear as written. Today the whole input must appear as one substring, so results get broader. |

### 3. Qualifiers

| Qualifier | Matches bookmarks that… |
|---|---|
| `#tag`, `tag:"…"` | carry the tag or any of its descendants (D). A path such as `#编程/后端` matches tags whose path ends with those segments. An unknown tag matches nothing. |
| `in:"collection"` | are in a collection of the active workspace with that name, case-insensitively. |
| `site:example.com` | have that host or a subdomain of it, ignoring a leading `www.`. The value is a host only. |
| `url:…` | have the text in their URL. |
| `title:…` | have the text in their title. |
| `is:fav` | are favorites. |
| `is:tagged` | carry at least one existing tag. |
| `has:notes` | have notes. |
| `has:cover` | have a cover (C1). |
| `has:snapshot` | have a ready snapshot (C2). |
| `is:broken` | are possibly broken (C2). |
| `after:YYYY-MM-DD`, `before:YYYY-MM-DD` | were created on or after, or on or before, that local date. |
| `age:<N` / `age:>N` | were created less or more than N ago. Units: `d`, `w`, `m` (30 days), `y` (365 days). |
| `updated:<N` / `updated:>N` | were last edited less or more than N ago, using B's edit time or the creation time. |

`has:snapshot` and `is:broken` match nothing when the server does not support snapshots.

### 4. Tolerance

- Unknown qualifiers are plain text, so a pasted `https://…` URL still searches.
- Unbalanced quotes or parentheses are closed at the end of the input; nothing is ever reported as an error.
- Text that starts with `#` is searched literally when quoted, such as `"#1"`.

### 5. Evaluation

- `lib/search-query.ts` exports `parseSearchQuery(input)`, which builds a small syntax tree, and `matchesSearchQuery(bookmark, query, context)`.
- The context holds the tag tree (paths and descendants), the active workspace's collections by name, a snapshot lookup (C2, optional), and the current time.
- The data lives in several stores, so, as in D, views assemble the context outside the stores and pass a predicate to the bookmarks store's list getters. The bookmarks store keeps no dependency on the workspace or snapshot stores.
- A query is parsed once per change and each bookmark is tested once, which stays fast for tens of thousands of bookmarks.

### 6. Input help

- Typing `#` or `tag:` suggests tag paths, `in:` suggests the active workspace's collections, and `is:` and `has:` suggest their values. Tab or Enter completes the highlighted suggestion.
- A "?" button next to each search box opens a popover with every qualifier and examples.

### 7. Smart collections: data and sync

- `SmartCollection { id, name, query, position, seq, deletedAt?, updatedAt }` in `lib/types.ts`. Smart collections are global, like tags.
- **Server** (TabSlate-server):
  - A new `smart_collections` table: `id`, `user_id`, `name`, `query`, `position`, `seq`, `deleted_at`, `updated_at`.
  - Sync push and pull carry a new `smart_collections` entity list with last-write-wins on `updated_at` and tombstones, the same way tags work. Tombstone retention and account deletion follow tags.
  - Validation: a trimmed name of 1 to 100 characters and a query of at most 1,000 characters, or the entity is rejected with `invalid_field`.
  - At most 100 live smart collections per user; further ones are rejected with `quota_exceeded` and type `smart_collection`.
  - Pull's `capabilities` gains `smart_collections: true`.
- **Extension:**
  - `store/smart-collections-store.ts` hydrates, creates, updates, deletes, merges pulled rows, and sweeps unsynced rows. `StoreGate` waits for it, and `onPullSuccess` merges it before writing `localSeq`.
  - IndexedDB gains a `smart-collections` store in the next database version after the ones already shipped. Logout clears it with the rest of the database.
  - Without the `smart_collections` capability, smart collections stay on the device and are never pushed, so older servers do not cause endless re-pushes.
  - Smart collections created as a guest are pushed after signing in, like tags.
  - The extension blocks creating a 101st smart collection with a quota alert: "You can have up to 100 smart collections".
- **Firefox:** queries are search terms the user typed, under the already declared `searchTerms` category of the account-data consent. The comment on `FIREFOX_ACCOUNT_DATA_COLLECTION` and the Firefox bullet in `CLAUDE.md` mention them.

### 8. Smart collections: interface

- **Sidebar.** A "Smart collections" section between Collections and Tags lists them newest first, each with an icon and its name. The sidebar shows no counts; evaluating up to 100 queries against every bookmark on each change would cost too much. The list header shows the result count instead.
- **Opening one.**
  - Clicking a smart collection switches to "All bookmarks" in the active workspace, clears the selected collection, tags, and type filter, and puts its query in the header search.
  - The header shows a chip, "Smart collection: «name»", and results stay grouped by collection.
  - Changing the workspace, collection, tags, or type filter, clearing the search, or removing the chip leaves the smart collection.
- **Changing one.** Editing the query while a smart collection is open shows "Save changes" and "Save as new".
- **Creating one.**
  - A "Save as smart collection" button appears beside the header search whenever it has a query.
  - The section's "+" opens the same dialog with an empty query.
  - The name defaults to the query.
- **Right-click menu:** Rename…, Edit query…, and Delete. Deleting asks for confirmation and says that no bookmarks are affected.

### 9. Importing Karakeep smart lists (F)

F's Karakeep import converts smart lists into smart collections:
- `list:` becomes `in:`.
- `#`, `tag:`, `is:fav`, `is:tagged`, `has:notes`, `url:`, `title:`, `after:`, `before:`, and `age:` carry over unchanged.
- A list with any other qualifier (such as `is:archived`, `has:highlights`, `feed:`, or `source:`) is skipped and named in the import summary.

## Components and Files

Frontend, new:

- `lib/search-query.ts` — parsing, the syntax tree, matching, and the context type.
- `store/smart-collections-store.ts`.
- `components/dashboard/search/search-help.tsx` — the "?" popover.
- `components/dashboard/search/query-suggestions.tsx` — qualifier suggestions under a search input.
- `components/dashboard/sidebar/smart-collections-section.tsx` and `smart-collection-dialog.tsx`.

Frontend, modified:

- `store/bookmarks-store.ts` — list getters take a predicate instead of the substring search.
- `components/dashboard/header.tsx` — the query hint, suggestions, the smart collection chip, and the save actions.
- `components/dashboard/search-box.tsx` — local results, server results filtered by the query.
- `components/dashboard/content.tsx`, `favorites-content.tsx`, `archive-content.tsx`, `trash-content.tsx` — building the query context and predicate.
- `lib/types.ts`, `lib/api.ts`, `lib/idb.ts`, the sync engine's entity types and queue, `lib/sync-confirmation.ts`.
- `entrypoints/newtab/App.tsx` — `StoreGate` and `onPullSuccess`.
- F's `lib/import-karakeep.ts` — smart list conversion.
- `lib/browser/data-collection-permissions.ts` (comment), both `messages.json`, `CLAUDE.md`, `ARCHITECTURE.md`.

TabSlate-server: `db/schema.pg.sql`, `internal/model/model.go`, `internal/handler/sync.go` (push, pull, capability), the cleanup job, their tests, and the server's `CLAUDE.md` and `ARCHITECTURE.md`.

TabSlate-cloud: none (build and test only).

## Error Handling

- Queries never fail: malformed input degrades to plain text.
- Server search errors leave the local results in place.
- Rejected smart collections (`invalid_field`, `quota_exceeded`) keep the server's state and show the quota alert for the limit.
- A smart collection whose query names a deleted tag or collection simply matches nothing for that part.

## Testing

Each behavior is implemented test-first.

- **Parser:** AND, `or`, parentheses, negation of terms and groups, quotes, unknown qualifiers, unbalanced input, and literal `#` text.
- **Matching:** every qualifier; tag path suffixes and descendants; `site:` with subdomains and `www.`; dates at day boundaries in different time zones; `age:` and `updated:` units; snapshot qualifiers with and without C2.
- **Search boxes:** the four lists filtering with the syntax; the new tab search box's local results, deduplicated server results, and qualifier filtering of server results; suggestions and completion; the help popover.
- **Smart collections:** opening, leaving, saving changes, saving as new, creating from the header and the sidebar, renaming, editing, deleting, and the 100 limit.
- **Sync:** the extension's merge, sweep, capability gating, and guest push; on the server, push and pull, last-write-wins, validation, the 100 limit, tombstones, and the capability flag.
- **Import:** Karakeep smart list conversion and skipping.

## Accessibility and Internationalization

- Suggestions use a `listbox` tied to the input with `aria-activedescendant`.
- The help popover is reachable by keyboard and labeled.
- The smart collection chip's remove button is labeled with the collection's name.
- Qualifier names stay in English in every language; their descriptions in the help popover are translated. Every new string is translated in English and Simplified Chinese with `[component]_[description]` keys.

## Resolved During Design

- **Global smart collections with their own sync.** Workspace-scoped ones would join the workspace delete, restore, and purge lifecycle; storing them in `/preferences` would turn the list into one last-write-wins value and, on Firefox, depend on the settings-sync permission rather than account-data consent.
- **Local results in the new tab search box.** Server-only results left guests and offline users without bookmark results and could not apply qualifiers.
- **No sidebar counts.** Counting every smart collection on each change does not scale to 100 queries over large libraries; the list header shows the open one's count.
