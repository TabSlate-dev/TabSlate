# Nested Tags and Import Hierarchy (Sub-project D)

## Summary

TabSlate's tags are flat, and importing browser bookmarks loses every folder level below the first: each first-level folder becomes a collection and deeper subfolders are flattened into it. This sub-project lets tags nest. A tag can have a parent, the sidebar shows tags as a tree, selecting a parent tag also matches its descendants, and typing `编程/后端/Go` creates all three levels at once. Imports keep the full folder hierarchy as a tag tree under one root tag per import, so imported bookmarks can be reviewed and reorganized with B's bulk actions. Two cleanup tools, borrowed from Karakeep, help afterwards: merging one tag into another, and deleting every tag that no bookmark uses.

Collections stay one level deep. The hierarchy is added to tags only.

## Roadmap Context

This is the fifth sub-project derived from the faved.to comparison (see `docs/superpowers/specs/2026-10-15-library-management-basics-design.md`). Each has its own spec, plan, and implementation cycle.

| Sub-project | Scope | Repositories |
|---|---|---|
| A — Library management basics | View preferences, tag and collection editing, counts, tag search, clickable tags, save shortcut, duplicate detection | Frontend |
| B — Bulk operations and unified form | Multi-select and bulk bar, unified add/edit form, notes, edit time, more sort options | Frontend + server |
| C1 — Image card view | Small and large card views, `og:image` covers read at save time, placeholders | Frontend + server (one field) |
| C2 — Web snapshots | Server-side page capture, snapshot viewer, full-page archives on demand, snapshot full-text search, storage quota | Server + cloud + frontend |
| **D — Nested tags and import hierarchy** (this spec) | Tag hierarchy, parent rollups, tag tree in the sidebar, folder hierarchy preserved on import | Frontend + server |
| E — Onboarding | Seed content and guided first-run steps | Frontend |

The comparison weighed nested collections against nested tags. Collections are the new tab page's main layout and drop targets, so nesting them would affect list rendering, drag and drop, and sync throughout. Nested tags only affect the sidebar, the tag pickers, and filtering, and they can absorb deep import folders.

**Depends on A and B.** D replaces A's sidebar tag chips with a tree and extends A's tag dialog, tag menu, and delete confirmation. It also changes B's tag picker and bulk Tags menu. It does not depend on C1 or C2.

## Goals

- Let tags have parents, up to five levels deep.
- Show tags as a collapsible tree in the sidebar, with counts and search.
- Make selecting a tag match bookmarks that carry it or any of its descendants.
- Create nested tags quickly with `/` paths.
- Move, rename, and delete tags without losing their children.
- Keep the full folder hierarchy of imported browser bookmarks, and make imported bookmarks easy to find and reorganize.
- Sync the hierarchy, and keep older extensions and servers working.
- Clean up tags after imports: merge duplicates and delete unused tags.

## Non-goals

- Nested collections.
- Dragging tags to change their parent, and dropping bookmarks on tags to tag them.
- Tag descriptions and pinned tags, which faved has.
- Per-device ordering of tags; siblings are sorted by name.
- Syncing which tags are expanded.
- New import sources or importing straight from the browser's bookmarks API.
- Changes to how imports create collections or detect duplicates.

## Decisions

| Question | Decision |
|---|---|
| Where the hierarchy lives | Tags only. Collections stay flat. |
| Data model | A `parentId` on each tag, not paths encoded in tag names. |
| Depth | At most five levels. |
| Name uniqueness | Unique among siblings, case-insensitively. Tags under different parents may share a name. |
| Selecting a parent | Also matches bookmarks that carry any descendant. Counts follow the same rule. |
| Deleting a parent | Its children move up one level. Bookmarks lose only the deleted tag. |
| Sidebar layout | Tree rows styled like collection rows, replacing A's chips. |
| Quick creation | `/` separates levels when creating a tag; existing levels are reused. |
| Import | First-level folders still become collections. The full folder hierarchy becomes a tag tree under a root tag such as "Chrome import 2026-10-21". |
| Merging | "Merge into…" moves a tag's bookmarks and children to another tag and deletes it. Same-named children merge too. |
| Unused tags | "Delete unused tags" removes every tag that no bookmark uses, counting archived and trashed bookmarks in all workspaces. |

## Design

### 1. Tag model and sync

**Data.**

- `Tag` in `lib/types.ts` gains `parentId?: string`. A missing value means a top-level tag, so existing IndexedDB records need no migration.
- TabSlate-server's `tags` table gains `parent_id TEXT` (`db/schema.pg.sql`, idempotent). It has no foreign key, because a push may carry a child before its parent.
- `model.Tag` gains `ParentID *string json:"parent_id,omitempty"`. In a push, an absent field keeps the stored parent, which is what older extensions send; `""` moves the tag to the top level; an ID sets that parent. The extension always sends `parent_id`, using `""` for top-level tags. Pull and the REST tag endpoints always return `parent_id`, using `""` for a stored root. Omission in a response is reserved for compatibility with older servers and preserves a local parent.

**Rules.**

- **Depth.** A tag can be at most five levels deep, counting the top level as level one.
- **Sibling names.** Names are unique among tags with the same parent, compared trimmed and case-insensitively. Tag names cannot contain `/`, because `/` separates levels when creating tags. Existing tags whose names already contain `/` keep them until renamed. New or renamed segments are limited to 50 Unicode code points, matching the existing REST limit; unchanged legacy names remain usable.
- **No cycles.** The sync push validates each tag's parent: the parent must be one of the user's tags, the tag must not become its own ancestor (the server walks the parent chain, including other tags in the same push), and the result must not exceed five levels. Validation covers the final admitted graph, including the deepest descendants of a moved subtree and excluding stale, foreign, or quota-rejected proposals. A hierarchy violation rejects that tag with `invalid_field` and `field: "parent_id"`. When two devices concurrently make two tags each other's parent, the later push is rejected. On that rejection the extension drops its local parent change, takes the server's value, and does not report a sync conflict.
- **Missing parents.** A tag whose parent is deleted or unknown is shown at the top level. Nothing is written back automatically; the next edit of that tag saves the parent it is shown under. This avoids sync churn between devices.
- **Order.** Siblings are sorted by name with the current language's collation, case-insensitively. Today tags are listed in creation order.

**Operations** (`store/workspace-store.ts`).

- **Create.** Creating `后端/Go` under `编程` creates the missing levels and reuses existing ones, matched by sibling name. New tags take their parent's color. The creation and quota check cover all new levels together.
- **Move.** `moveTag(id, parentId)` changes the parent. The targets exclude the tag itself, its descendants, and any position that would exceed five levels.
- **Rename.** Changes only the tag; its children are unaffected.
- **Delete.** Moves the tag's children to its parent (or the top level), then tombstones the tag, in one state update and one sync enqueue. If a promoted child would collide with a sibling name, keep both IDs and suffix the promoted child with " (2)", " (3)", etc.; reserve suffixes in stable ID order and within the name-length limit. Bookmarks keep their other tags and tag IDs. As today, dangling tag IDs on bookmarks are ignored when rendering. Pending tombstones persist in IndexedDB with `seq: 0`, remain hidden from active tag state, survive restart, and are removed only after matching acknowledgement or authoritative absence.

**Quota.** Every active tag counts against `max_tags`, including levels created implicitly and import trees. When an operation's new tags do not all fit, none are created and the existing quota alert appears.

**Compatibility.**

| Combination | Behavior |
|---|---|
| New extension, old server | The server ignores `parent_id`. The hierarchy stays on the device that created it, and pulls never clear it. |
| Old extension, new server | Its pushes omit `parent_id`, so the hierarchy is kept. It lists all tags flat, and same-named children look like duplicates there. |
| New extension, new server | The hierarchy syncs. |

**Deployment order.** TabSlate-server, then TabSlate-cloud (build and test only), then the extension. The extension also works against servers that have not been updated.

### 2. Sidebar tag tree

**Rows.** The tags section (`components/dashboard/sidebar/tags-section.tsx`) replaces A's chips with one row per tag, styled like collection rows:

- an expand arrow, only on tags with children;
- the tag's color dot and name;
- the count, right-aligned;
- one indentation step per level.

**Counts.** A row counts the active bookmarks in the active workspace that carry the tag or any of its descendants, each bookmark once, using A's visibility rule. A count of 0 is shown muted, as in A.

**Selection.**

- Clicking a row toggles the tag in `selectedTags`, as clicking a chip does today. Several tags can be selected.
- Selected rows use the selected collection's highlight.
- Rows are buttons with `aria-pressed`; the arrow is a separate button with `aria-expanded`.
- When a nested tag becomes selected (for example from a card), its ancestors expand so the row is visible.

**Expansion.**

- Top-level tags show by default; their children start collapsed.
- Expanded tag IDs are stored in IndexedDB `kv` under `tag-tree-expanded`, so each new tab keeps the last state.
- Expansion is per device and does not sync.
- The tags section itself stays collapsible, and the one-second "Right-click to edit" tooltip stays.

**Search.**

- The search box filters by a case-insensitive substring of tag names.
- Matching tags show with their ancestors, which expand; non-matching siblings are hidden, and the matched text is highlighted.
- Esc or × closes the search. As in A, searching never changes the selected tags.

**Right-click menu.**

- **Rename…** — the name cannot contain `/`.
- **Color ▸** — unchanged.
- **New child tag…** (new) — opens the tag dialog with this tag as the parent.
- **Move to…** (new) — a searchable tag tree with a "Top level" entry. The tag itself, its descendants, and positions that would exceed five levels are disabled.
- **Delete…** — the confirmation adds "N child tags will move up one level" when the tag has children.

**Tag dialog** (A's `TagDialog`).

- A new **Parent** field uses the same searchable tag tree. It defaults to the top level, or to the tag a "New child tag" request came from.
- When creating, the name may contain `/`: `后端/Go` with parent `编程` creates `编程 › 后端 › Go`, reusing levels that exist.
- Validation errors show inline: an empty name or empty path segment (such as `a//b`), a sibling with the same name, or more than five levels.
- When editing, the Parent field moves the tag, with the same targets as **Move to…**.

### 3. Filtering and tag display

**Filtering.**

- Selecting a tag selects it together with all its descendants. Several selected tags still match a bookmark that carries any of them. The main list and the Favorites page follow this rule.
- The expansion from selected tags to their descendants happens outside `store/bookmarks-store.ts`: components compute it from the tag tree and pass the expanded set in, so the bookmarks store keeps no dependency on the workspace store.
- Filters store tag IDs, so a moved tag keeps matching its new descendants.

**Display rules** (everywhere):

- Paths are displayed as `编程 › 后端 › Go`. `/` is only used for input.
- Card tags (`components/ui/tag-list.tsx`) show the tag's own name, such as `Go`, with the full path in a tooltip. Clicking still filters by the tag, including its descendants.
- The filter chips (`ActiveFilterChips`) show the full path, truncated with the full text in a tooltip.
- Archive and Trash cards that show tags follow the same rules.

**B's tag picker** (`components/dashboard/shared/tag-picker.tsx`).

- Selected tags stay removable chips that show the tag's own name, with the full path in a tooltip.
- The filter input matches any segment of a tag's path. Results show full paths, exact name matches first, then by path.
- When no tag matches the input exactly, it offers "Create «…»". The picker has no parent field, so a path with `/` is created from the top level (reusing existing levels), and a name without `/` creates a top-level tag.

**B's bulk Tags menu** (`components/dashboard/bulk-actions/tags-menu.tsx`).

- Tags are listed as an indented tree.
- The three-state checkboxes still apply to each tag on its own: checking a parent adds only the parent, not its descendants.
- Search and creation follow the picker's rules.

**Popup** (`entrypoints/popup/App.tsx`, `lib/storage.ts`).

- Suggestions show full paths and match the same way.
- Enter picks the first suggestion. With no suggestions it creates the tag; an input with `/` creates the path from the top level.
- The popup still writes tags straight to IndexedDB. New tags carry `parentId`, and duplicate checks compare siblings.

**One implementation.** `lib/tag-tree.ts` holds the tree helpers used by every surface:

- building the tree;
- paths and their display form;
- descendants and ancestors;
- resolving a typed path against the tree, relative to a parent (tag dialog) or from the top level (picker, bulk menu, popup);
- sibling-name and depth validation;
- valid move targets.

`lib/tag-name.ts`'s `tagNameError` checks names against siblings.

### 4. Import

**Chrome bookmarks** (`lib/import-chrome.ts`).

- **Collections** are unchanged: each first-level folder becomes a collection, bookmarks placed directly in a root folder go to a collection named after it, and duplicate names get " (2)". The parser additionally records each bookmark's folder path below its collection.
- **Tag tree.**
  - The import creates a root tag named "Chrome import «YYYY-MM-DD»" ("Chrome 导入 «YYYY-MM-DD»" in Chinese). If a top-level tag with that name exists, the name gets " (2)".
  - The root's children match the collections, with the same names; below them the folder hierarchy is copied.
  - Each imported bookmark gets the tag of its own folder. A bookmark in `书签栏/开发/前端/React` goes to the 开发 collection and gets `Chrome import 2026-10-21 › 开发 › 前端 › React`. A bookmark placed directly in 开发 gets `… › 开发`.
  - Only folders that contain imported bookmarks, directly or in subfolders, become tags. Same-named folders under the same parent become one tag.
  - The tree lives under its own root, so it never merges with the user's existing tags.
  - Five levels fit the root, the collection level, and three more levels. Deeper folders merge into their level-five ancestor's tag.
  - Duplicates that the import skips are not imported, so they get no tags.
- **Option.** The import dialog gains "Record the import source and folder hierarchy as tags", on by default. Turned off, the import behaves exactly as today.
- **Quota.**
  - The summary lists the collections, tags, and bookmarks the import will create.
  - Collection and bookmark quotas still block the import, as today.
  - When the tag tree does not fit the tag quota, only the root tag is created and every imported bookmark gets it; the summary says so. When even the root does not fit, no tags are created.

**Toby** (`lib/import-toby.ts`).

- Lists still become collections and labels still become tags. Labels match existing top-level tags by name.
- With the option on, a root tag "Toby import «YYYY-MM-DD»" is added to every imported bookmark. Toby exports have no folders, so the root has no children. Reserve mandatory new label tags before budgeting the optional root; if the labels themselves cannot fit, block the import rather than silently dropping labels.

**After importing.**

- When a root tag was actually committed, the success message has a "Show imported bookmarks" button. It switches to "All bookmarks" in the target workspace, clears the other filters, and selects only the import's root tag, ready for B's bulk actions.
- When a root exists, the message also explains that deleting the root tag after reorganizing moves its child tags up one level. Without a root (option off or quota exhausted), omit that button and explanation.

Imported folder/label names are literal segments, never typed paths: trim them, replace `/` with `／`, use localized "Untitled" for empty segments, and truncate new segments to 50 Unicode code points. Distinct original names that collide after normalization receive suffixes; equivalent original sibling names coalesce. Existing collections and tags are not renamed.

`ImportPlan` (`lib/import-types.ts`) carries the new tags with their parents, and `importFromPlan` in `store/workspace-store.ts` adds them with the collections and bookmarks.

### 5. Merging tags and deleting unused tags

**Merge into…** (a new item in a tag's right-click menu):

- It opens the tag tree picker. The tag itself, its descendants, and targets that would put a descendant deeper than five levels are disabled.
- A confirmation explains the result: "Merge «A» into «B»? N bookmarks will use «B» instead, A's child tags will move under B, and A will be deleted."
- `mergeTag(sourceId, targetId)` in `store/workspace-store.ts`:
  - Every bookmark that carries A gets B instead, without duplicates. This covers active, archived, and trashed bookmarks in every workspace. Buckets that are loaded change in state; buckets that are not loaded change in IndexedDB only, following the `_archivedLoaded` and `_trashedLoaded` rule.
  - A's children move under B. A child whose name matches one of B's children (compared like sibling names) merges into it the same way, recursively.
  - A, and any child merged away, is tombstoned.
  - The changes go out in one sync enqueue, split by B's byte-limited push chunks.
- If A was selected in the tag filter, B takes its place.
- Deleted and merged-away tags stop counting against `max_tags` when tombstoned, matching the existing active-tag quota (`deleted_at IS NULL`). Physical tombstone retention cleanup is separate; there is no new tag permanent-delete UI.

**Delete unused tags** (a new item in a ⋯ menu on the Tags section header):

- A tag is unused when no bookmark carries it or any of its descendants. Active, archived, and trashed bookmarks count, in every workspace, because tags are shared across workspaces.
- Before counting, the action loads the archived and trashed buckets with `loadArchivedBookmarks()` and `loadTrashedBookmarks()`, which keep them loaded.
- The menu item shows the count, "Delete unused tags (N)", and is disabled at zero. A confirmation lists up to ten of the names, then "and N more".
- Confirming tombstones all of them in one update and one sync enqueue. No children need to move, because the descendants of an unused tag are unused too.

## Components and Files

Frontend, new:

- `lib/tag-tree.ts` — tree, path, descendant, resolution, validation, and move-target helpers.
- `components/dashboard/shared/tag-tree-picker.tsx` — the searchable tag tree used by **Move to…** and the tag dialog's Parent field.

Frontend, modified:

- `lib/types.ts` (`Tag.parentId`), `lib/tag-name.ts` (sibling checks), `lib/api.ts` (`parent_id`), `lib/sync-confirmation.ts`, `lib/storage.ts` (popup tag creation)
- `store/workspace-store.ts` (create with paths, `moveTag`, delete moving children up, `mergeTag`, deleting unused tags, sync mapping and merge, import), `store/bookmarks-store.ts` (filtering with an expanded tag set, replacing a tag across all buckets)
- `components/dashboard/sidebar/tag-merge-dialog.tsx` and `unused-tags-dialog.tsx` — the merge and cleanup confirmations
- `components/dashboard/sidebar/tags-section.tsx`, `tag-dialog.tsx`, `tag-delete-dialog.tsx`
- `components/ui/tag-list.tsx`, `components/dashboard/shared/active-filter-chips.tsx`, `shared/tag-picker.tsx`, `bulk-actions/tags-menu.tsx`, and the components that pass selected tags to the filter (`content.tsx`, `favorites-content.tsx`)
- `entrypoints/popup/App.tsx`
- `lib/import-chrome.ts`, `lib/import-toby.ts`, `lib/import-types.ts`, `components/dashboard/import-dialog.tsx`
- both `messages.json`, `CLAUDE.md` (the `tag-tree-expanded` key, tag hierarchy rules), `ARCHITECTURE.md`

TabSlate-server: `db/schema.pg.sql`, `internal/model/model.go`, `internal/handler/sync.go` (push validation, pull), `internal/handler/tags.go` (REST parent support and validation), their tests, and the server's `CLAUDE.md` and `ARCHITECTURE.md`.

TabSlate-cloud: none (build and test only).

## Error Handling

- **Invalid parents.** Cycles, foreign parents, and depth violations are rejected per tag with `invalid_field`. The extension takes the server's value without reporting a conflict.
- **Quota.** Tag creation that does not fit creates nothing and shows the quota alert. Imports fall back to the root tag, or to no tags.
- **Concurrent deletes.** A tag whose parent was deleted on another device shows at the top level until it is edited.
- **Old data.** Tags whose names contain `/` keep working; only creation and renaming reject `/`.

## Testing

Each behavior is implemented test-first, with the happy-dom helpers and module save-and-restore pattern from A.

- **Unit tests:**
  - `lib/tag-tree.ts`: building trees, paths, descendants, relative and absolute path resolution, sibling-name and depth validation, move targets, and missing parents shown at the top level;
  - counts that include descendants once per bookmark, and filtering with descendants;
  - sync: `parent_id` absent, `""`, and an ID; merge; confirmation comparisons; dropping a local move after a rejection;
  - delete moving children up in one update;
  - the Chrome parser's folder paths: nesting, empty folders, same-named folders, more than five levels, and bookmarks directly in root folders;
  - import plans: root tag name collisions, the root-only fallback, and Toby's root tag;
  - merging: bookmarks in all three buckets (loaded and not loaded) switching tags without duplicates, recursive merging of same-named children, the selected filter following the merge, and one sync enqueue;
  - unused tags: counting across workspaces and buckets, parents of used tags staying, and one update.
- **Component tests:**
  - the sidebar tree: expand and collapse persisting across mounts, ancestors expanding for a selected tag, and search keeping ancestors with highlights;
  - the right-click menu: **New child tag…**, disabled **Move to…** and **Merge into…** targets, the merge confirmation, and the child count in the delete confirmation;
  - the Tags section's ⋯ menu: the unused-tag count, the disabled state at zero, and the confirmation;
  - the tag dialog's Parent field, `/` creation, and errors;
  - path tooltips on card tags and paths in the filter chips;
  - B's tag picker and bulk Tags menu with paths and creation;
  - the popup's suggestions and Enter behavior;
  - the import dialog's option, summary, and "Show imported bookmarks".
- **Server tests** (Go, in the existing handler test style): push with `parent_id` absent, `""`, and an ID; rejections for cycles (including within one push), foreign parents, and depth; pull and REST returning the field; REST create and update with parents; the schema migration running twice.
- **Cloud:** `go test ./...` after the server change.
- **Manual check:** import a real Chrome export with deep folders; use an older extension against the new server and confirm that editing a tag keeps its parent; make two tags each other's parent on two devices at once and confirm the later push is rejected and both devices end up matching the server.

## Accessibility and Internationalization

- Tag rows are buttons with `aria-pressed`; expand arrows are buttons with `aria-expanded` and labels naming the tag.
- The tag tree picker is keyboard navigable and labeled; disabled targets are announced as unavailable.
- Paths use `›` as the visual separator, with the full path available to screen readers through the row or tooltip label.
- Every new string is translated in English and Simplified Chinese with `[component]_[description]` keys, including the import root tag's name.

## Resolved During Design

- **`parentId` instead of paths in names.** Paths in names would need every descendant renamed when a parent is renamed, and concurrent edits on two devices could split a hierarchy. A parent reference keeps renames to one tag and makes moves explicit; the server only needs one column and a cycle check.
- **Children move up on delete.** faved deletes a tag's children with it. Moving them up keeps their bookmarks' organization and makes import cleanup a single delete of the root tag.
- **Import under a root tag.** Mapping deep folders onto existing tags would merge unrelated same-named folders (such as "Docs" in two collections). A root tag per import keeps the tree intact, lets users review imported bookmarks with one filter, and can be dissolved by deleting it.
- **Tree rows replace A's chips.** A kept chips for compactness, but chips cannot show which tag belongs to which parent; tree rows match the collection rows and support expansion and search.
