# Bulk Operations and Unified Bookmark Form Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let people select many bookmarks and act on them at once, add and edit bookmarks in one form that includes plain-text notes, record when each bookmark was last edited, and sort by edit time and by website, with notes and edit times synced through TabSlate-server.

**Architecture:** The server gains two additive bookmark columns, `notes` and `edited_at`, carried by sync push and pull, REST and the search index; a write without them keeps the stored notes. The extension adds a non-persisted selection store, a ref-based context that gives each card its view's order without re-rendering it, three batch actions in the bookmarks store (one state update, one IndexedDB transaction and one sync enqueue each), a bulk action bar, and one `BookmarkForm` inside a `BookmarkDialog` that `WorkspaceRail` mounts and a window event opens. Push chunks gain a byte limit.

**Tech Stack:** TabSlate-server: Go 1.25, Gin, pgx v5, PostgreSQL 17, MeiliSearch. Extension: TypeScript (strict), React 19, Zustand 5, react-router-dom 7, WXT (MV3, Chromium and Firefox), shadcn/Radix (`radix-ui` 1.6.7), dnd-kit, `@tanstack/react-virtual`, Bun test with happy-dom.

**Spec:** `docs/superpowers/specs/2026-10-15-bulk-operations-and-unified-form-design.md`

## Global Constraints

- Extension tasks run from `/Users/lieutenant/Documents/github/TabSlate` on branch `feat/bookmark-library-ux`. Server tasks run from `/Users/lieutenant/Documents/github/TabSlate-server` on branch `feat/bookmark-notes`, which Task 1 creates from `main`. TabSlate-cloud (`/Users/lieutenant/Documents/github/TabSlate-Cloud`) is only built and tested; nothing is committed there.
- Never push, open a pull request, or merge into `main`. Do not create git worktrees.
- TypeScript strict: never `any`; `unknown` only to parse external data; interfaces for object shapes; braces on every `if`; avoid `as` and `!` (the `as const` on literal write operations that `store/bookmarks-store.ts` already uses is fine).
- Zustand: one selector per field (`useStore((s) => s.field)`); never destructure a store; a selector may compute a boolean or string, but never a new array or object (derive those with `useMemo`). `syncEngine?.enqueue()` is never called inside a `set()` updater.
- New components use named exports; event handlers are named `handle…`; callbacks passed to memoized children are wrapped in `useCallback`.
- Every new UI string goes into both `public/_locales/en/messages.json` and `public/_locales/zh_CN/messages.json` (2-space JSON; `[component]_[description]` keys; `$1`/`$2` declared under `"placeholders"` like `bookmarksContent_bookmarkCount_other`) and is read with `t()` from `@/hooks/use-translation`. Chinese terms: collection = 收藏集, note = 备注, archive = 归档, trash = 回收站, favorite = 收藏.
- Dialogs keep the standard shadcn structure. Forms that show inline errors use `onSubmit` with `preventDefault`. Floating notices use the `Alert` pattern from `CLAUDE.md` (fixed, top center, `z-100`) with `role="status"`.
- Tests live in `test/*.test.ts(x)`. Each file starts with `// @ts-expect-error Bun provides this test module at runtime.` on the line before the `bun:test` import. Swap modules only through `test/helpers/module-replacer.ts` with complete replacements (`{ ...realModule, override }`), and restore them in `afterAll`. Component tests use `test/helpers/dom-environment.ts`.
- The popup and background never import a data store (`store/bookmarks-store`, `workspace-store`, `groups-store`, `tabs-store`, `settings-store`, `auth-store`, `plan-store`, `selection-store`) or a module that does.
- Notes limit: `MAX_BOOKMARK_NOTES_LENGTH = 10_000` (UTF-16 code units) in the extension, `MaxBookmarkNotesLength = 10000` (runes) on the server. Push chunk limit: `MAX_SYNC_PUSH_BYTES = 384 * 1024`.
- Extension checks: `bun test <file>`, `bun test`, `bun run compile`, `bun run build`, `bun run build:firefox`. Server checks: `gofmt -l .` (prints nothing), `go build ./...`, `go vet ./...`, `go test ./...` with `TEST_DATABASE_URL` set.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Notes on the Spec

The plan settles these details the spec leaves open or states differently:

1. `BookmarkDialog` registers its own `tabslate-open-bookmark` listener; `WorkspaceRail` only mounts it. The behavior is the spec's, and the dialog can be tested without the rail's other dialogs.
2. The edit time sent for a bookmark without `updatedAt` is `bookmarkCreatedAtTime(createdAt)` rather than `Date.parse(createdAt)`. Records merged from older servers store `createdAt` as an epoch string, which `Date.parse` reads as `NaN` and JSON then sends as `null`.
3. `search.BookmarkDoc.Notes` is tagged `json:"notes,omitempty"`, so search responses, which never retrieve notes, carry no empty `notes` key. MeiliSearch `AddDocuments` replaces whole documents, so clearing a note still removes it from the index.
4. The `cmd/reindex` tool also indexes notes; otherwise a reindex would drop them.
5. TabSlate-cloud resolves TabSlate-server through `replace github.com/TabSlate-dev/TabSlate-server => ../TabSlate-server`, so there is no version to bump. Task 2 builds and tests it against the local server.
6. Shared UI added for the spec's pickers: `components/ui/popover.tsx` and `components/ui/textarea.tsx` (standard shadcn), `components/dashboard/shared/filterable-list.tsx` (filter input and listbox with arrow keys and an optional create row, used by the collection picker, the tag picker and the bulk Tags menu), and `lib/tag-name.ts`, which holds A's tag-name rules so the tag dialog and both pickers share them. A tag created from a picker takes the next color in `TAG_COLORS`.
7. The Favorites page currently ignores the sort order. The spec says it uses the current sort, so sorting moves to `sortBookmarks` in `lib/bookmark-utils.ts`, and Favorites uses it.
8. "Open as a tab group" goes through a new `useTabsStore.openUrlsAsGroup`, which `openCollectionAsGroup` now uses as well, so the compact-title setting and full-title storage apply to it. Groups opened from a selection are grey.
9. A card is selectable only inside a `SelectionOrdersProvider`. The drag overlay renders a card outside one, so it never shows a checkbox.
10. The drag sensor also ignores presses inside `[role="dialog"]`. The notes popover renders in a portal, but its pointer events bubble through React to the card's drag wrapper.
11. When the bookmark quota blocks an add, the form stays open (the quota alert explains why) instead of closing and losing the input.
12. An edit is compared with the bookmark as it was when the form opened. A field another device changed meanwhile is overwritten only if the user edited that field too.
13. Translation keys used only by the deleted dialogs are removed. The popup reuses its existing, unused `popup_note` and `popup_addNote` keys.

## Prerequisites

Server handler tests need PostgreSQL 17 and skip themselves when `TEST_DATABASE_URL` is unset, so a skipped run is not a pass. Every server test step below checks for `--- PASS` lines; a `--- SKIP` means the step failed.

```bash
docker info >/dev/null 2>&1 || echo "Docker is not running: ask the user to start OrbStack"
docker run -d --name tabslate-b-test-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=tabslate_test -p 55432:5432 postgres:17
export TEST_DATABASE_URL='postgres://postgres:test@localhost:55432/tabslate_test?sslmode=disable'
```

If the container already exists, start it with `docker start tabslate-b-test-pg`. Ask the user before starting OrbStack. Remove the container with `docker rm -f tabslate-b-test-pg` when the server tasks are done.

## File Structure

TabSlate-server:

| File | Change |
|---|---|
| `db/schema.pg.sql` | Add `notes` and `edited_at` columns (idempotent) |
| `internal/model/model.go` | `Bookmark.Notes`, `Bookmark.EditedAt`, `BookmarkRequest.Notes`, `MaxBookmarkNotesLength`, `RejectionReasonInvalidField` |
| `internal/handler/sync.go` | Notes validation, upsert with `RETURNING notes`, pull fields, `syncBookmarkSearchDoc` |
| `internal/handler/bookmarks.go` | REST list, create and update carry notes and set `edited_at` |
| `internal/handler/workspace_lifecycle.go` | Restore-time search documents include notes |
| `internal/search/types.go`, `internal/search/client.go` | `BookmarkDoc.Notes`; `notes` is searchable |
| `cmd/reindex/main.go` | Reindex includes notes |
| `internal/handler/bookmark_notes_test.go` | New tests |
| `CLAUDE.md`, `ARCHITECTURE.md` | Document the fields |

Extension, new files:

| File | Responsibility |
|---|---|
| `store/selection-store.ts` | Ephemeral selection: selected IDs, anchor, toggle/range/many/retain/clear |
| `hooks/use-selection-scope.ts` | Prune the selection to a view, clear it when the view's scope changes or it unmounts, clear it on Esc |
| `lib/platform.ts` | macOS detection and the Cmd/Ctrl toggle-click rule |
| `lib/tag-name.ts` | A's tag-name rules (required, unique ignoring case) |
| `lib/bulk-tags.ts` | Three-state tag computation and the resulting patches |
| `lib/bookmark-clipboard.ts` | Plain and Markdown link lists |
| `lib/linkify.ts` | Split note text into text and link segments |
| `lib/bookmark-dialog-events.ts` | `tabslate-open-bookmark` event and `openBookmarkDialog()` |
| `components/ui/popover.tsx`, `components/ui/textarea.tsx` | shadcn primitives |
| `components/dashboard/shared/selection-orders.tsx` | `SelectionOrdersProvider` and `useSelectionOrders()` |
| `components/dashboard/shared/filterable-list.tsx` | Filter input and listbox with keyboard navigation and an optional create row |
| `components/dashboard/shared/collection-picker.tsx` | Searchable active-collection list with "New collection…" |
| `components/dashboard/shared/tag-picker.tsx` | Chip-based tag picker for the form |
| `components/dashboard/shared/bookmark-form.tsx` | `BookmarkForm`, the form body |
| `components/dashboard/shared/bookmark-dialog.tsx` | `BookmarkDialog`, the dialog and its event listener |
| `components/dashboard/shared/bookmark-notes-popover.tsx` | Notes button and popover on cards |
| `components/dashboard/bulk-actions/index.tsx` | `BulkActionBar` |
| `components/dashboard/bulk-actions/bulk-notice.tsx` | Floating notice and its 3-second timer |
| `components/dashboard/bulk-actions/tags-menu.tsx` | Three-state bulk Tags menu |
| `components/dashboard/bulk-actions/open-tabs-confirm-dialog.tsx` | "Open N tabs?" confirmation |
| `test/helpers/bookmarks-store-harness.ts` | Fresh bookmarks store with recorded IndexedDB writes and sync enqueues |
| `test/helpers/virtualizer.ts` | Measured virtualizer and a quiet tabs store for list tests |

Extension, modified: `lib/types.ts`, `lib/api.ts`, `lib/bookmark-utils.ts`, `lib/url-match.ts`, `lib/view-preferences.ts`, `lib/sync-recovery.ts`, `lib/sync-confirmation.ts`, `lib/storage.ts`, `lib/chrome/tabs.ts`, `lib/drag-sensors.ts`, `lib/browser/data-collection-permissions.ts`, `store/bookmarks-store.ts`, `store/tabs-store.ts`, `components/dashboard/content.tsx`, `favorites-content.tsx`, `bookmark-card.tsx`, `header.tsx`, `workspace-rail.tsx`, `shared/bookmark-menu-items.tsx`, `sidebar/tag-dialog.tsx`, `entrypoints/popup/App.tsx`, `entrypoints/background.ts`, `test/helpers/dom-environment.ts`, both `messages.json`, `CLAUDE.md`, `ARCHITECTURE.md`, and the tests named in each task.

Extension, deleted: `components/dashboard/add-bookmark-dialog.tsx`, `components/dashboard/shared/edit-bookmark-dialog.tsx`, `components/dashboard/shared/bookmark-tags-dialog.tsx`, and `test/add-bookmark-duplicates.test.tsx` (its tests move to `test/bookmark-form-duplicates.test.tsx`).

---

## Part 1: TabSlate-server

### Task 1: Notes and edit time in sync push and pull

**Files:**
- Modify: `db/schema.pg.sql` (append at the end)
- Modify: `internal/model/model.go` (`Bookmark` lines 69–86, `BookmarkRequest` lines ~194–204, rejection constants lines ~216–221)
- Modify: `internal/search/types.go`
- Modify: `internal/handler/sync.go` (imports; bookmark validation ~830–849; upsert ~851–897; pull ~1162–1186; new helper at the end)
- Create: `internal/handler/bookmark_notes_test.go`

**Interfaces:**
- Produces: `model.MaxBookmarkNotesLength = 10000`; `model.RejectionReasonInvalidField = "invalid_field"`; `model.Bookmark.Notes *string` (`json:"notes,omitempty"`, nil means "not sent"); `model.Bookmark.EditedAt *int64` (`json:"edited_at,omitempty"`); `model.BookmarkRequest.Notes *string` (`json:"notes" binding:"omitempty,max=10000"`); `search.BookmarkDoc.Notes string` (`json:"notes,omitempty"`); `syncBookmarkSearchDoc(userID string, bookmark model.Bookmark, storedNotes string) search.BookmarkDoc`; test helpers `readStoredBookmarkNotes`, `allowNextBookmarkPush` (Task 2 reuses them).

- [ ] **Step 1: Create the server branch**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
git status --short
git switch main
git switch -c feat/bookmark-notes
```

Expected: `git status --short` prints nothing (the tree is clean at `9dd971a`).

- [ ] **Step 2: Write the failing tests**

Create `internal/handler/bookmark_notes_test.go`:

```go
package handler

import (
	"strings"
	"testing"
	"time"

	"github.com/TabSlate-dev/TabSlate-server/db"
	"github.com/TabSlate-dev/TabSlate-server/internal/model"
	"github.com/TabSlate-dev/TabSlate-server/internal/search"
)

type storedBookmarkNotes struct {
	notes    string
	editedAt *int64
}

func readStoredBookmarkNotes(t *testing.T, testDB *db.DB, bookmarkID string) storedBookmarkNotes {
	t.Helper()
	var stored storedBookmarkNotes
	if err := testDB.QueryRow(t.Context(),
		`SELECT notes, edited_at FROM bookmarks WHERE id = $1`, bookmarkID,
	).Scan(&stored.notes, &stored.editedAt); err != nil {
		t.Fatalf("read bookmark %s notes: %v", bookmarkID, err)
	}
	return stored
}

// allowNextBookmarkPush moves the stored server time back, so a second push
// in the same millisecond is not rejected as stale.
func allowNextBookmarkPush(t *testing.T, testDB *db.DB, bookmarkID string) {
	t.Helper()
	if _, err := testDB.Exec(t.Context(), `UPDATE bookmarks SET updated_at = 1 WHERE id = $1`, bookmarkID); err != nil {
		t.Fatalf("rewind bookmark %s: %v", bookmarkID, err)
	}
}

func pushNotesBookmarks(t *testing.T, testDB *db.DB, userID string, bookmarks ...model.Bookmark) model.SyncPushResponse {
	t.Helper()
	recorder := pushSync(t, testDB, userID, syncTestLimits(), model.SyncPushEntities{Bookmarks: bookmarks})
	assertSyncStatusOK(t, recorder)
	return decodeSyncPushResponse(t, recorder)
}

func TestSyncPushStoresBookmarkNotesAndEditTime(t *testing.T) {
	testDB := openSyncTestDB(t)
	userID := insertAuthTestUser(t, testDB, authTestUserSeed{email: "sync-notes-store@example.com", password: "password123"})
	bookmark := model.Bookmark{ID: "notes-bookmark", Title: "Notes", URL: "https://notes.example.com"}

	withNotes := bookmark
	withNotes.Notes = stringPtr("Why I saved it")
	withNotes.EditedAt = int64Ptr(1234)
	if rejected := pushNotesBookmarks(t, testDB, userID, withNotes).Rejected; len(rejected) != 0 {
		t.Fatalf("rejected = %#v, want none", rejected)
	}
	stored := readStoredBookmarkNotes(t, testDB, bookmark.ID)
	if stored.notes != "Why I saved it" || stored.editedAt == nil || *stored.editedAt != 1234 {
		t.Fatalf("stored = %q/%v, want the pushed notes and edited_at 1234", stored.notes, stored.editedAt)
	}

	allowNextBookmarkPush(t, testDB, bookmark.ID)
	before := time.Now().UnixMilli()
	if rejected := pushNotesBookmarks(t, testDB, userID, bookmark).Rejected; len(rejected) != 0 {
		t.Fatalf("rejected = %#v, want none", rejected)
	}
	stored = readStoredBookmarkNotes(t, testDB, bookmark.ID)
	if stored.notes != "Why I saved it" {
		t.Fatalf("notes = %q, want a push without notes to keep them", stored.notes)
	}
	if stored.editedAt == nil || *stored.editedAt < before {
		t.Fatalf("edited_at = %v, want the server time of a push without edited_at", stored.editedAt)
	}

	allowNextBookmarkPush(t, testDB, bookmark.ID)
	cleared := bookmark
	cleared.Notes = stringPtr("")
	cleared.EditedAt = int64Ptr(5678)
	if rejected := pushNotesBookmarks(t, testDB, userID, cleared).Rejected; len(rejected) != 0 {
		t.Fatalf("rejected = %#v, want none", rejected)
	}
	stored = readStoredBookmarkNotes(t, testDB, bookmark.ID)
	if stored.notes != "" || stored.editedAt == nil || *stored.editedAt != 5678 {
		t.Fatalf("stored = %q/%v, want cleared notes and edited_at 5678", stored.notes, stored.editedAt)
	}
}

func TestSyncPushNewBookmarkWithoutNotesGetsDefaults(t *testing.T) {
	testDB := openSyncTestDB(t)
	userID := insertAuthTestUser(t, testDB, authTestUserSeed{email: "sync-notes-defaults@example.com", password: "password123"})

	before := time.Now().UnixMilli()
	pushNotesBookmarks(t, testDB, userID, model.Bookmark{ID: "legacy-push", Title: "Legacy", URL: "https://legacy.example.com"})

	stored := readStoredBookmarkNotes(t, testDB, "legacy-push")
	if stored.notes != "" || stored.editedAt == nil || *stored.editedAt < before {
		t.Fatalf("stored = %q/%v, want empty notes and the server time", stored.notes, stored.editedAt)
	}
}

func TestSyncPushRejectsOverlongBookmarkNotes(t *testing.T) {
	testDB := openSyncTestDB(t)
	userID := insertAuthTestUser(t, testDB, authTestUserSeed{email: "sync-notes-limit@example.com", password: "password123"})
	longest := strings.Repeat("笔", model.MaxBookmarkNotesLength)
	tooLong := longest + "!"

	response := pushNotesBookmarks(t, testDB, userID,
		model.Bookmark{ID: "longest-notes", Title: "Longest", URL: "https://longest.example.com", Notes: &longest},
		model.Bookmark{ID: "too-long-notes", Title: "Too long", URL: "https://too-long.example.com", Notes: &tooLong},
	)

	assertRejected(t, response, model.Rejected{ID: "too-long-notes", Reason: model.RejectionReasonInvalidField, Type: "bookmark"})
	if len(response.Rejected) != 1 {
		t.Fatalf("rejected = %#v, want only the over-long bookmark", response.Rejected)
	}
	assertEntityCount(t, testDB, `SELECT COUNT(*) FROM bookmarks WHERE id = 'too-long-notes'`, 0)
	if stored := readStoredBookmarkNotes(t, testDB, "longest-notes"); stored.notes != longest {
		t.Fatalf("notes length = %d runes, want %d", len([]rune(stored.notes)), model.MaxBookmarkNotesLength)
	}
}

func TestSyncPushStaleBookmarkKeepsStoredNotes(t *testing.T) {
	testDB := openSyncTestDB(t)
	userID := insertAuthTestUser(t, testDB, authTestUserSeed{email: "sync-notes-stale@example.com", password: "password123"})
	future := time.Now().Add(time.Hour).UnixMilli()
	if _, err := testDB.Exec(t.Context(), `
		INSERT INTO bookmarks (id, user_id, collection_id, title, url, favicon_url, description,
		                       position, seq, is_trashed, created_at, updated_at, notes, edited_at)
		VALUES ('stale-notes', $1, NULL, 'Newer', 'https://stale.example.com', '', '', 0, 1, 0, 1, $2, 'Server notes', 99)`,
		userID, future); err != nil {
		t.Fatalf("insert newer bookmark: %v", err)
	}

	response := pushNotesBookmarks(t, testDB, userID, model.Bookmark{
		ID: "stale-notes", Title: "Older", URL: "https://stale.example.com", Notes: stringPtr("Older notes"),
	})

	assertRejected(t, response, staleRejection("stale-notes", "bookmark"))
	stored := readStoredBookmarkNotes(t, testDB, "stale-notes")
	if stored.notes != "Server notes" || stored.editedAt == nil || *stored.editedAt != 99 {
		t.Fatalf("stored = %q/%v, want the newer row untouched", stored.notes, stored.editedAt)
	}
}

func TestSyncPullReturnsBookmarkNotesAndEditTime(t *testing.T) {
	testDB := openSyncTestDB(t)
	userID := insertAuthTestUser(t, testDB, authTestUserSeed{email: "sync-notes-pull@example.com", password: "password123"})
	if _, err := testDB.Exec(t.Context(), `INSERT INTO user_sync_seq (user_id, seq) VALUES ($1, 2)`, userID); err != nil {
		t.Fatalf("insert user sync sequence: %v", err)
	}
	if _, err := testDB.Exec(t.Context(), `
		INSERT INTO bookmarks (id, user_id, collection_id, title, url, favicon_url, description,
		                       position, seq, is_trashed, created_at, updated_at, notes, edited_at)
		VALUES ('pull-notes', $1, NULL, 'With notes', 'https://notes.example.com', '', '', 0, 1, 0, 1, 1, 'Pulled notes', 4321),
		       ('pull-legacy', $1, NULL, 'Legacy', 'https://legacy.example.com', '', '', 0, 2, 0, 1, 1, DEFAULT, NULL)`,
		userID); err != nil {
		t.Fatalf("insert pull bookmarks: %v", err)
	}

	response := pullSync(t, testDB, userID, 0)

	byID := map[string]model.Bookmark{}
	for _, bookmark := range response.Entities.Bookmarks {
		byID[bookmark.ID] = bookmark
	}
	withNotes := byID["pull-notes"]
	if withNotes.Notes == nil || *withNotes.Notes != "Pulled notes" || withNotes.EditedAt == nil || *withNotes.EditedAt != 4321 {
		t.Fatalf("pull-notes = %v/%v, want notes and edited_at 4321", withNotes.Notes, withNotes.EditedAt)
	}
	legacy := byID["pull-legacy"]
	if legacy.Notes == nil || *legacy.Notes != "" {
		t.Fatalf("pull-legacy notes = %v, want an empty string so clients can clear notes", legacy.Notes)
	}
	if legacy.EditedAt != nil {
		t.Fatalf("pull-legacy edited_at = %d, want it absent", *legacy.EditedAt)
	}
}

func TestSyncBookmarkSearchDocUsesStoredNotes(t *testing.T) {
	collectionID := "collection"
	doc := syncBookmarkSearchDoc("user", model.Bookmark{
		ID: "bookmark", Title: "Title", URL: "https://doc.example.com", Description: "Description",
		CollectionID: &collectionID, IsArchived: true,
	}, "Stored notes")

	want := search.BookmarkDoc{
		ID: "bookmark", UserID: "user", Title: "Title", URL: "https://doc.example.com", Description: "Description",
		Notes: "Stored notes", CollectionID: "collection", IsArchived: true,
	}
	if doc != want {
		t.Fatalf("doc = %#v, want %#v", doc, want)
	}
}

func TestBookmarkNotesMigrationRunsTwice(t *testing.T) {
	testDB := openSyncTestDB(t)
	if err := db.Migrate(testDB); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
	var notesDefault, notesNullable, editedNullable string
	if err := testDB.QueryRow(t.Context(), `
		SELECT notes.column_default, notes.is_nullable, edited.is_nullable
		FROM information_schema.columns notes
		JOIN information_schema.columns edited
		  ON edited.table_schema = notes.table_schema AND edited.table_name = notes.table_name AND edited.column_name = 'edited_at'
		WHERE notes.table_schema = current_schema() AND notes.table_name = 'bookmarks' AND notes.column_name = 'notes'`,
	).Scan(&notesDefault, &notesNullable, &editedNullable); err != nil {
		t.Fatalf("read bookmark columns: %v", err)
	}
	if notesNullable != "NO" || !strings.HasPrefix(notesDefault, "''") || editedNullable != "YES" {
		t.Fatalf("notes default/nullable = %q/%q, edited_at nullable = %q", notesDefault, notesNullable, editedNullable)
	}
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `go test ./internal/handler -run 'BookmarkNotes|SyncPush(Stores|NewBookmarkWithout|RejectsOverlong|StaleBookmarkKeeps)|SyncPullReturnsBookmarkNotes|SyncBookmarkSearchDoc' -v`
Expected: the package does not build: `unknown field Notes in struct literal of type model.Bookmark` (and `undefined: syncBookmarkSearchDoc`).

- [ ] **Step 4: Add the columns, model fields and search field**

Append to `db/schema.pg.sql`:

```sql

-- Bookmark notes and the client-reported time of the user's last edit.
-- edited_at stays NULL for rows written before it existed; clients fall back
-- to updated_at for those.
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS edited_at BIGINT;
```

In `internal/model/model.go`, add the constant directly above `// Bookmark is a saved URL.` and the two fields at the end of `Bookmark`:

```go
// MaxBookmarkNotesLength is the longest note a bookmark may carry, in characters.
const MaxBookmarkNotesLength = 10000

// Bookmark is a saved URL.
type Bookmark struct {
	ID           string   `json:"id"`
	UserID       string   `json:"user_id"`
	CollectionID *string  `json:"collection_id"`
	Title        string   `json:"title"`
	URL          string   `json:"url"`
	FaviconURL   string   `json:"favicon_url,omitempty"`
	Description  string   `json:"description,omitempty"`
	IsFavorite   bool     `json:"is_favorite"`
	IsArchived   bool     `json:"is_archived"`
	IsTrashed    int      `json:"is_trashed"` // 0=active 1=trashed 2=permanently deleted
	TagIDs       []string `json:"tag_ids"`
	Position     int      `json:"position"`
	CreatedAt    int64    `json:"created_at"`
	UpdatedAt    int64    `json:"updated_at"`
	Seq          int64    `json:"seq"`
	DeletedAt    *int64   `json:"deleted_at,omitempty"`
	// Notes is nil when a client did not send it; such writes keep the stored notes.
	Notes *string `json:"notes,omitempty"`
	// EditedAt is the client-reported Unix ms of the user's last edit; nil for rows that predate it.
	EditedAt *int64 `json:"edited_at,omitempty"`
}
```

Add `Notes` to `BookmarkRequest`, after `Description`:

```go
	Notes        *string `json:"notes"       binding:"omitempty,max=10000"`
```

Add the reason to the rejection constants:

```go
const (
	RejectionReasonLastActiveWorkspace = "last_active_workspace"
	RejectionReasonWorkspaceDeleted    = "workspace_deleted"
	RejectionReasonParentDeleted       = "parent_deleted"
	RejectionReasonPermanentlyDeleted  = "permanently_deleted"
	RejectionReasonInvalidField        = "invalid_field"
)
```

Replace `internal/search/types.go`:

```go
package search

// BookmarkDoc is a MeiliSearch document representing one bookmark.
type BookmarkDoc struct {
	ID           string `json:"id"`
	UserID       string `json:"userId"`
	Title        string `json:"title"`
	URL          string `json:"url"`
	Description  string `json:"description"`
	Notes        string `json:"notes,omitempty"`
	CollectionID string `json:"collectionId"`
	IsArchived   bool   `json:"isArchived"`
}
```

- [ ] **Step 5: Validate, upsert and pull the fields in sync**

In `internal/handler/sync.go`, add `"errors"` and `"unicode/utf8"` to the standard-library imports:

```go
import (
	"errors"
	"fmt"
	"log"
	"net/http"
	"time"
	"unicode/utf8"
```

In the bookmark loop, reject over-long notes right after the `invalid_state` check:

```go
	for _, bookmark := range req.Entities.Bookmarks {
		if bookmark.IsTrashed < 0 || bookmark.IsTrashed > 2 {
			rejected = append(rejected, model.Rejected{ID: bookmark.ID, Reason: "invalid_state", Type: "bookmark"})
			continue
		}
		if bookmark.Notes != nil && utf8.RuneCountInString(*bookmark.Notes) > model.MaxBookmarkNotesLength {
			rejected = append(rejected, model.Rejected{
				ID: bookmark.ID, Reason: model.RejectionReasonInvalidField, Type: "bookmark",
			})
			continue
		}
```

Replace the upsert batch and its results loop (from `if len(bookmarkUpserts) > 0 {` through the `br.Close()` check):

```go
	if len(bookmarkUpserts) > 0 {
		batch := &pgx.Batch{}
		for _, bm := range bookmarkUpserts {
			tagIDs := bm.TagIDs
			if tagIDs == nil {
				tagIDs = []string{}
			}
			// A push without notes (an extension that predates them) keeps the
			// stored notes; a push without edited_at records the server time.
			batch.Queue(`
				INSERT INTO bookmarks (id, user_id, collection_id, title, url, favicon_url, description,
				                       is_favorite, is_archived, is_trashed, position, seq, deleted_at, created_at, updated_at, tag_ids,
				                       notes, edited_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,COALESCE($16::text, ''),COALESCE($17::bigint, $14))
				ON CONFLICT (id) DO UPDATE
				  SET collection_id=$3, title=$4, url=$5, favicon_url=$6, description=$7,
				      is_favorite=$8, is_archived=$9, is_trashed=$10, position=$11, seq=$12, deleted_at=$13, updated_at=$14, tag_ids=$15,
				      notes=COALESCE($16::text, bookmarks.notes), edited_at=COALESCE($17::bigint, $14)
				WHERE bookmarks.user_id = $2 AND bookmarks.updated_at < $14
				RETURNING notes`,
				bm.ID, userID, bm.CollectionID, bm.Title, bm.URL, bm.FaviconURL, bm.Description,
				bm.IsFavorite, bm.IsArchived, bm.IsTrashed, bm.Position, seq, bm.DeletedAt, now, tagIDs,
				bm.Notes, bm.EditedAt)
		}
		br := tx.SendBatch(ctx, batch)
		for _, bm := range bookmarkUpserts {
			var storedNotes string
			err := br.QueryRow().Scan(&storedNotes)
			if errors.Is(err, pgx.ErrNoRows) {
				rejected = append(rejected, staleRejection(bm.ID, "bookmark"))
				continue
			}
			if err != nil {
				br.Close()
				respondSyncDatabaseError(c, "bookmark upsert", userID, bookmarkIDs, err)
				return
			}
			if bm.DeletedAt != nil || bm.IsTrashed > 0 {
				searchDeletes = append(searchDeletes, bm.ID)
				continue
			}
			searchUpserts = append(searchUpserts, syncBookmarkSearchDoc(userID, bm, storedNotes))
		}
		if closeErr := br.Close(); closeErr != nil {
			respondSyncDatabaseError(c, "close bookmark batch", userID, bookmarkIDs, closeErr)
			return
		}
	}
```

In `Pull`, select and scan the two columns:

```go
	bmRows, err := h.db.Query(ctx,
		`SELECT id, user_id, collection_id, title, url, favicon_url, description,
                is_favorite, is_archived, is_trashed, tag_ids, position, seq, deleted_at, created_at, updated_at,
                notes, edited_at
         FROM bookmarks WHERE user_id=$1 AND seq>$2 ORDER BY seq ASC`,
		userID, afterSeq)
```

```go
		if err := bmRows.Scan(&bm.ID, &bm.UserID, &bm.CollectionID, &bm.Title, &bm.URL, &bm.FaviconURL,
			&bm.Description, &bm.IsFavorite, &bm.IsArchived, &bm.IsTrashed, &bm.TagIDs, &bm.Position,
			&bm.Seq, &bm.DeletedAt, &bm.CreatedAt, &bm.UpdatedAt, &bm.Notes, &bm.EditedAt); err != nil {
```

Append the helper at the end of `internal/handler/sync.go`:

```go
// syncBookmarkSearchDoc builds a pushed bookmark's search document from the
// notes stored by the upsert: a push from an extension that predates notes
// sends none, and the index must keep the stored ones.
func syncBookmarkSearchDoc(userID string, bookmark model.Bookmark, storedNotes string) search.BookmarkDoc {
	return search.BookmarkDoc{
		ID:           bookmark.ID,
		UserID:       userID,
		Title:        bookmark.Title,
		URL:          bookmark.URL,
		Description:  bookmark.Description,
		Notes:        storedNotes,
		CollectionID: derefStr(bookmark.CollectionID),
		IsArchived:   bookmark.IsArchived,
	}
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `gofmt -w internal/model/model.go internal/search/types.go internal/handler/sync.go internal/handler/bookmark_notes_test.go && gofmt -l . && go build ./... && go test ./internal/handler -run 'BookmarkNotes|SyncPush(Stores|NewBookmarkWithout|RejectsOverlong|StaleBookmarkKeeps)|SyncPullReturnsBookmarkNotes|SyncBookmarkSearchDoc' -v`
Expected: `gofmt -l .` prints nothing; seven `--- PASS` lines (`TestSyncPushStoresBookmarkNotesAndEditTime`, `TestSyncPushNewBookmarkWithoutNotesGetsDefaults`, `TestSyncPushRejectsOverlongBookmarkNotes`, `TestSyncPushStaleBookmarkKeepsStoredNotes`, `TestSyncPullReturnsBookmarkNotesAndEditTime`, `TestSyncBookmarkSearchDocUsesStoredNotes`, `TestBookmarkNotesMigrationRunsTwice`) and no `--- SKIP`.

- [ ] **Step 7: Run the handler package**

Run: `go vet ./... && go test ./internal/... 2>&1 | tail -20`
Expected: every package `ok`; no `FAIL`.

- [ ] **Step 8: Commit**

```bash
git add db/schema.pg.sql internal/model/model.go internal/search/types.go internal/handler/sync.go internal/handler/bookmark_notes_test.go
git commit -m "feat(sync): carry bookmark notes and edit time

Pushes without notes keep the stored notes and pushes without
edited_at record the server time, so older extensions keep working.
Over-long notes are rejected per bookmark with invalid_field.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Notes in REST, search and docs; Cloud check

**Files:**
- Modify: `internal/handler/bookmarks.go` (`List` ~31–78, `Create` ~80–193, `Update` ~195–262; imports)
- Modify: `internal/handler/workspace_lifecycle.go` (`workspaceSearchDocuments` ~498–530)
- Modify: `internal/search/client.go` (`initIndex` settings ~54–57)
- Modify: `cmd/reindex/main.go` (query and scan ~73–92)
- Modify: `CLAUDE.md`, `ARCHITECTURE.md`
- Test: `internal/handler/bookmark_notes_test.go`

**Interfaces:**
- Consumes: `model.Bookmark.Notes`/`EditedAt`, `model.BookmarkRequest.Notes`, `search.BookmarkDoc.Notes`, `readStoredBookmarkNotes` (Task 1).
- Produces: REST `GET /bookmarks` returns `notes` and `edited_at`; `POST /bookmarks` stores the notes (empty when absent) and returns `notes` and `edited_at`; `PUT /bookmarks/:id` keeps stored notes when `notes` is absent and sets `edited_at` to the server time; restore-time and reindex search documents include notes; `notes` is the fourth searchable attribute.

- [ ] **Step 1: Write the failing tests**

Add `"encoding/json"` and `"net/http"` to the imports of `internal/handler/bookmark_notes_test.go`:

```go
import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/TabSlate-dev/TabSlate-server/db"
	"github.com/TabSlate-dev/TabSlate-server/internal/model"
	"github.com/TabSlate-dev/TabSlate-server/internal/pubsub"
	"github.com/TabSlate-dev/TabSlate-server/internal/search"
)
```

Append to the file:

```go
func insertNotesCollection(t *testing.T, testDB *db.DB, userID, workspaceID, collectionID string) {
	t.Helper()
	insertWorkspaceLifecycleRoot(t, testDB, userID, workspaceID, 0)
	if _, err := testDB.Exec(t.Context(), `
		INSERT INTO collections (id, user_id, workspace_id, name, icon, position, seq, is_deleted, created_at, updated_at)
		VALUES ($1, $2, $3, 'Reading', '', 0, 1, 0, 1, 1)`, collectionID, userID, workspaceID); err != nil {
		t.Fatalf("insert collection %s: %v", collectionID, err)
	}
}

func marshalBookmarkRequest(t *testing.T, request model.BookmarkRequest) []byte {
	t.Helper()
	body, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("marshal bookmark request: %v", err)
	}
	return body
}

func TestBookmarkRESTCarriesNotes(t *testing.T) {
	testDB := openSyncTestDB(t)
	userID := insertAuthTestUser(t, testDB, authTestUserSeed{email: "bookmark-rest-notes@example.com", password: "password123"})
	collectionID := "rest-notes-collection"
	insertNotesCollection(t, testDB, userID, "rest-notes-workspace", collectionID)
	handler := NewBookmarkHandler(testDB, nil, pubsub.NewInMemoryHub(), fixedLimitsProvider{limits: syncTestLimits()})

	var created model.Bookmark
	decodeHandlerResponse(t, performHandlerRequest(t, userID, http.MethodPost, "/bookmarks", marshalBookmarkRequest(t, model.BookmarkRequest{
		CollectionID: &collectionID, Title: "Doc", URL: "https://doc.example.com", Notes: stringPtr("First note"),
	}), handler.Create), http.StatusCreated, &created)
	if created.Notes == nil || *created.Notes != "First note" || created.EditedAt == nil {
		t.Fatalf("created notes/edited_at = %v/%v, want both", created.Notes, created.EditedAt)
	}

	var withoutNotes model.Bookmark
	decodeHandlerResponse(t, performHandlerRequest(t, userID, http.MethodPost, "/bookmarks", marshalBookmarkRequest(t, model.BookmarkRequest{
		CollectionID: &collectionID, Title: "Plain", URL: "https://plain.example.com",
	}), handler.Create), http.StatusCreated, &withoutNotes)
	if stored := readStoredBookmarkNotes(t, testDB, withoutNotes.ID); stored.notes != "" {
		t.Fatalf("notes = %q, want empty for a create without notes", stored.notes)
	}

	var listed []model.Bookmark
	decodeHandlerResponse(t, performHandlerRequest(t, userID, http.MethodGet, "/bookmarks", nil, handler.List), http.StatusOK, &listed)
	notesByID := map[string]string{}
	for _, bookmark := range listed {
		if bookmark.Notes == nil || bookmark.EditedAt == nil {
			t.Fatalf("listed %s notes/edited_at = %v/%v, want both", bookmark.ID, bookmark.Notes, bookmark.EditedAt)
		}
		notesByID[bookmark.ID] = *bookmark.Notes
	}
	if notesByID[created.ID] != "First note" {
		t.Fatalf("listed notes = %#v, want First note for %s", notesByID, created.ID)
	}

	update := func(request model.BookmarkRequest) int {
		recorder := performHandlerRequestWithParam(t, userID, http.MethodPut, "/bookmarks/"+created.ID,
			marshalBookmarkRequest(t, request), "id", created.ID, handler.Update)
		return recorder.Code
	}
	before := time.Now().UnixMilli()
	if code := update(model.BookmarkRequest{CollectionID: &collectionID, Title: "Doc renamed", URL: "https://doc.example.com"}); code != http.StatusOK {
		t.Fatalf("update without notes status = %d", code)
	}
	stored := readStoredBookmarkNotes(t, testDB, created.ID)
	if stored.notes != "First note" || stored.editedAt == nil || *stored.editedAt < before {
		t.Fatalf("stored = %q/%v, want kept notes and the server time", stored.notes, stored.editedAt)
	}

	if code := update(model.BookmarkRequest{CollectionID: &collectionID, Title: "Doc renamed", URL: "https://doc.example.com", Notes: stringPtr("Second note")}); code != http.StatusOK {
		t.Fatalf("update with notes status = %d", code)
	}
	if stored := readStoredBookmarkNotes(t, testDB, created.ID); stored.notes != "Second note" {
		t.Fatalf("notes = %q, want Second note", stored.notes)
	}

	tooLong := strings.Repeat("a", model.MaxBookmarkNotesLength+1)
	if code := update(model.BookmarkRequest{CollectionID: &collectionID, Title: "Doc renamed", URL: "https://doc.example.com", Notes: &tooLong}); code != http.StatusBadRequest {
		t.Fatalf("over-long notes status = %d, want 400", code)
	}
	if stored := readStoredBookmarkNotes(t, testDB, created.ID); stored.notes != "Second note" {
		t.Fatalf("notes = %q, want a rejected update to change nothing", stored.notes)
	}
}

func TestBookmarkRESTUpdateOfMissingBookmarkIsNotFound(t *testing.T) {
	testDB := openSyncTestDB(t)
	userID := insertAuthTestUser(t, testDB, authTestUserSeed{email: "bookmark-rest-missing@example.com", password: "password123"})
	collectionID := "rest-missing-collection"
	insertNotesCollection(t, testDB, userID, "rest-missing-workspace", collectionID)
	handler := NewBookmarkHandler(testDB, nil, pubsub.NewInMemoryHub(), fixedLimitsProvider{limits: syncTestLimits()})

	recorder := performHandlerRequestWithParam(t, userID, http.MethodPut, "/bookmarks/missing",
		marshalBookmarkRequest(t, model.BookmarkRequest{CollectionID: &collectionID, Title: "Missing", URL: "https://missing.example.com"}),
		"id", "missing", handler.Update)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d body=%s, want 404", recorder.Code, recorder.Body.String())
	}
}

func TestWorkspaceSearchDocumentsIncludeNotes(t *testing.T) {
	testDB := openSyncTestDB(t)
	userID := insertAuthTestUser(t, testDB, authTestUserSeed{email: "workspace-search-notes@example.com", password: "password123"})
	insertNotesCollection(t, testDB, userID, "search-notes-workspace", "search-notes-collection")
	if _, err := testDB.Exec(t.Context(), `
		INSERT INTO bookmarks (id, user_id, collection_id, title, url, favicon_url, description,
		                       position, seq, is_trashed, created_at, updated_at, notes)
		VALUES ('search-notes-bookmark', $1, 'search-notes-collection', 'Indexed', 'https://indexed.example.com', '', '', 0, 1, 0, 1, 1, 'Indexed notes')`,
		userID); err != nil {
		t.Fatalf("insert bookmark: %v", err)
	}
	tx, err := testDB.Begin(t.Context())
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(t.Context())

	documents, err := workspaceSearchDocuments(t.Context(), tx, "search-notes-workspace")
	if err != nil {
		t.Fatalf("workspace search documents: %v", err)
	}
	if len(documents) != 1 || documents[0].Notes != "Indexed notes" {
		t.Fatalf("documents = %#v, want the bookmark with its notes", documents)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./internal/handler -run 'BookmarkREST|WorkspaceSearchDocumentsIncludeNotes' -v`
Expected: FAIL — `TestBookmarkRESTCarriesNotes` reports `created notes/edited_at = <nil>/<nil>, want both`; `TestWorkspaceSearchDocumentsIncludeNotes` reports documents without notes. No `--- SKIP`.

- [ ] **Step 3: Carry notes through REST**

In `internal/handler/bookmarks.go`, add `"errors"` to the imports:

```go
import (
	"errors"
	"fmt"
	"net/http"
	"time"
```

In `List`, select and scan the columns:

```go
	query := `SELECT b.id, b.user_id, b.collection_id, b.title, b.url, b.favicon_url, b.description,
	                 b.is_favorite, b.is_archived, b.is_trashed, b.position, b.seq, b.created_at, b.updated_at,
	                 b.notes, b.edited_at
	            FROM bookmarks b
```

```go
		rows.Scan(&b.ID, &b.UserID, &b.CollectionID, &b.Title, &b.URL,
			&b.FaviconURL, &b.Description, &b.IsFavorite, &b.IsArchived,
			&b.IsTrashed, &b.Position, &b.Seq, &b.CreatedAt, &b.UpdatedAt, &b.Notes, &b.EditedAt)
```

In `Create`, compute the notes once after `now := time.Now().UnixMilli()`:

```go
	id := uuid.NewString()
	now := time.Now().UnixMilli()
	notes := derefStr(req.Notes)
```

Replace both inserts:

```go
	if req.CollectionID == nil || *req.CollectionID == "" {
		tag, execErr := tx.Exec(ctx,
			`INSERT INTO bookmarks (id, user_id, collection_id, title, url, favicon_url,
			  description, is_favorite, is_archived, is_trashed, position, seq, created_at, updated_at, notes, edited_at)
			 VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,$12)`,
			id, userID, req.Title, req.URL, req.FaviconURL,
			req.Description, req.IsFavorite, req.IsArchived, boolToInt(req.IsTrashed), req.Position, seq, now, notes,
		)
		if execErr != nil {
			respondSyncDatabaseError(c, "bookmark insert", userID, []string{id}, execErr)
			return
		}
		rowsAffected = tag.RowsAffected()
	} else {
		tag, execErr := tx.Exec(ctx,
			`INSERT INTO bookmarks (id, user_id, collection_id, title, url, favicon_url,
			  description, is_favorite, is_archived, is_trashed, position, seq, created_at, updated_at, notes, edited_at)
			 SELECT $1,$2,c.id,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14,$13
			 FROM collections c
			 JOIN workspaces w ON w.id=c.workspace_id AND w.user_id=c.user_id
			 WHERE c.id=$3 AND c.user_id=$2 AND c.deleted_at IS NULL AND c.is_deleted=0 AND w.is_deleted=0`,
			id, userID, req.CollectionID, req.Title, req.URL, req.FaviconURL,
			req.Description, req.IsFavorite, req.IsArchived, boolToInt(req.IsTrashed), req.Position, seq, now, notes,
		)
```

Keep the rest of that branch as it is. Replace the search upsert and the response at the end of `Create`:

```go
	h.hub.Broadcast(userID, seq)
	if !req.IsTrashed {
		h.search.UpsertBookmark(search.BookmarkDoc{
			ID:           id,
			UserID:       userID,
			Title:        req.Title,
			URL:          req.URL,
			Description:  req.Description,
			Notes:        notes,
			CollectionID: derefStr(req.CollectionID),
			IsArchived:   req.IsArchived,
		})
	}
	c.JSON(http.StatusCreated, model.Bookmark{
		ID: id, UserID: userID, CollectionID: req.CollectionID,
		Title: req.Title, URL: req.URL, FaviconURL: req.FaviconURL,
		Description: req.Description, IsFavorite: req.IsFavorite,
		IsArchived: req.IsArchived, IsTrashed: boolToInt(req.IsTrashed),
		Position: req.Position, Seq: seq, CreatedAt: now, UpdatedAt: now,
		Notes: &notes, EditedAt: &now,
	})
```

In `Update`, replace the `tx.Exec` call and its two checks with a `QueryRow` that returns the stored notes:

```go
	// Absent notes keep the stored notes; the search document uses what is stored.
	var storedNotes string
	err = tx.QueryRow(ctx,
		`UPDATE bookmarks b
		 SET collection_id=$1, title=$2, url=$3, favicon_url=$4, description=$5,
		     is_favorite=$6, is_archived=$7, is_trashed=$8, position=$9, seq=$10, updated_at=$11,
		     notes=COALESCE($14::text, b.notes), edited_at=$11
		 FROM collections current_c
		 JOIN workspaces current_w ON current_w.id=current_c.workspace_id AND current_w.user_id=current_c.user_id,
		 collections target_c
		 JOIN workspaces target_w ON target_w.id=target_c.workspace_id AND target_w.user_id=target_c.user_id
		 WHERE b.id=$12 AND b.user_id=$13 AND b.deleted_at IS NULL
		   AND current_c.id=b.collection_id AND current_c.user_id=b.user_id
		   AND current_c.deleted_at IS NULL AND current_c.is_deleted=0 AND current_w.is_deleted=0
		   AND target_c.id=$1 AND target_c.user_id=b.user_id
		   AND target_c.deleted_at IS NULL AND target_c.is_deleted=0 AND target_w.is_deleted=0
		 RETURNING b.notes`,
		req.CollectionID, req.Title, req.URL, req.FaviconURL, req.Description,
		req.IsFavorite, req.IsArchived, boolToInt(req.IsTrashed), req.Position, seq, now, id, userID, req.Notes,
	).Scan(&storedNotes)
	if errors.Is(err, pgx.ErrNoRows) {
		c.JSON(http.StatusNotFound, gin.H{"error": "bookmark not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update bookmark"})
		return
	}
```

and add the notes to its search upsert:

```go
		h.search.UpsertBookmark(search.BookmarkDoc{
			ID:           id,
			UserID:       userID,
			Title:        req.Title,
			URL:          req.URL,
			Description:  req.Description,
			Notes:        storedNotes,
			CollectionID: derefStr(req.CollectionID),
			IsArchived:   req.IsArchived,
		})
```

- [ ] **Step 4: Index notes on restore, reindex and search settings**

In `internal/handler/workspace_lifecycle.go`, `workspaceSearchDocuments`:

```go
	rows, err := tx.Query(ctx, `
		SELECT b.id, b.user_id, b.title, b.url, COALESCE(b.description, ''), b.notes, b.collection_id, b.is_archived
		FROM bookmarks b
		JOIN collections c ON c.id = b.collection_id
		WHERE c.workspace_id = $1 AND b.is_trashed = 0
		ORDER BY b.id`, workspaceID)
```

```go
		if err := rows.Scan(
			&document.ID,
			&document.UserID,
			&document.Title,
			&document.URL,
			&document.Description,
			&document.Notes,
			&document.CollectionID,
			&document.IsArchived,
		); err != nil {
```

In `cmd/reindex/main.go`:

```go
	rows, err := database.Query(ctx,
		`SELECT id, user_id, title, url, COALESCE(description, ''), notes,
		        COALESCE(collection_id, ''), is_archived
		   FROM bookmarks
		  WHERE is_trashed = 0 AND deleted_at IS NULL`)
```

```go
		if err := rows.Scan(&doc.ID, &doc.UserID, &doc.Title, &doc.URL,
			&doc.Description, &doc.Notes, &doc.CollectionID, &doc.IsArchived); err != nil {
```

In `internal/search/client.go`, `initIndex`:

```go
	if _, err := c.index.UpdateSettings(&meilisearch.Settings{
		FilterableAttributes: []string{"userId"},
		SearchableAttributes: []string{"title", "url", "description", "notes"},
	}); err != nil {
```

Leave `AttributesToRetrieve` in `SearchBookmarks` unchanged, so search results do not return notes.

- [ ] **Step 5: Document the fields**

In `ARCHITECTURE.md`, replace the `bookmarks` row of the table list:

```markdown
| `bookmarks` | id, user_id, collection_id, seq, deleted_at, tag_ids text[], **is_trashed INT**, notes TEXT, edited_at BIGINT | `is_trashed`: 0/1/2 三态；`tag_ids` 存书签关联的 Tag ID 数组；`notes` 纯文本备注（`NOT NULL DEFAULT ''`，最多 10,000 字符）；`edited_at` 客户端上报的最后编辑时间（Unix ms，旧行为 NULL） |
```

Replace the MeiliSearch settings bullet:

```markdown
- 非空 → 在 `bookmarks` 索引上设置 `FilterableAttributes: ["userId"]`，`SearchableAttributes: ["title", "url", "description", "notes"]`（搜索结果不返回 `notes`）
```

Add after the `**冲突解决（LWW）**` bullet in 核心设计:

```markdown
- **书签备注与编辑时间**：`notes` 与 `edited_at` 是可选字段。Push 未携带 `notes`（旧扩展）时保留库中备注，未携带 `edited_at` 时写入服务端时间；`notes` 超过 10,000 字符（rune）时该书签以 `invalid_field` 拒绝。upsert `RETURNING notes`，搜索文档始终使用库中备注。`updated_at` 仍只用于 LWW，不受 `edited_at` 影响。Pull 与 REST 读取都返回两个字段；REST 更新未携带 `notes` 时保留原值
```

In `CLAUDE.md`, add after the `**Bookmark tag_ids**` bullet:

```markdown
- **Bookmark notes / edited_at**：`bookmarks.notes TEXT NOT NULL DEFAULT ''`、`bookmarks.edited_at BIGINT`（可空）。`model.Bookmark.Notes *string` / `EditedAt *int64`，nil 表示客户端未发送：Push 与 REST 更新未发送 `notes` 时保留库中值（`COALESCE`），未发送 `edited_at` 时写服务端时间；超过 `model.MaxBookmarkNotesLength`（10,000 rune）的 Push 以 `invalid_field` 拒绝，REST 由 `binding:"max=10000"` 返回 400。搜索文档（sync push、REST、workspace 恢复、`cmd/reindex`）都使用库中备注。
```

- [ ] **Step 6: Run the server suite**

Run: `gofmt -l . && go build ./... && go vet ./... && go test ./... 2>&1 | tail -25`
Expected: `gofmt -l .` prints nothing; every package `ok`; `go test ./internal/handler -run 'BookmarkREST|WorkspaceSearchDocumentsIncludeNotes' -v` shows three `--- PASS` lines and no `--- SKIP`.

- [ ] **Step 7: Build and test TabSlate-cloud against the local server**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-Cloud
grep -n 'TabSlate-server =>' go.mod
go build ./... && go vet ./... && go test ./... 2>&1 | tail -20
git status --short
cd /Users/lieutenant/Documents/github/TabSlate-server
```

Expected: the `replace` line points at `../TabSlate-server`; build, vet and tests succeed; `git status --short` prints nothing (no Cloud changes).

- [ ] **Step 8: Commit**

```bash
git add internal/handler/bookmarks.go internal/handler/workspace_lifecycle.go internal/search/client.go cmd/reindex/main.go internal/handler/bookmark_notes_test.go CLAUDE.md ARCHITECTURE.md
git commit -m "feat(bookmarks): notes in REST and the search index

REST reads return notes and edited_at, create stores the notes,
and an update without notes keeps them. Restore-time indexing and
the reindex tool include notes, and notes are searchable.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Part 2: Extension data and store

### Task 3: Notes and edit time in the bookmark model and sync mapping

**Files:**
- Modify: `lib/types.ts` (`Bookmark`, lines 31–44; new batch patch types)
- Modify: `lib/api.ts` (`ServerBookmark`, lines 97–114)
- Modify: `lib/bookmark-utils.ts`
- Modify: `store/bookmarks-store.ts`
- Modify: `lib/sync-confirmation.ts` (`matchesBookmark`, ~151–175)
- Create: `test/helpers/bookmarks-store-harness.ts`
- Test: `test/bookmark-sync-fields.test.ts` (new), `test/sync-confirmation.test.ts`

**Interfaces:**
- Produces: `Bookmark.notes?: string` (missing means `""`) and `Bookmark.updatedAt?: number` (Unix ms of the user's last change); `BookmarkBatchPatch` and `BookmarkPatchEntry` in `lib/types.ts` (Task 5 uses them); `ServerBookmark.notes?: string`, `ServerBookmark.edited_at?: number`; `MAX_BOOKMARK_NOTES_LENGTH = 10_000` and `bookmarkEditedAt(updatedAt: number | undefined, createdAt: string): number` in `lib/bookmark-utils.ts`; pushed bookmark entities always carry `notes` and `edited_at`; `installBookmarksStoreHarness(replacer): Promise<BookmarksStoreHarness>` with `useBookmarksStore`, `usePlanStore`, `enqueued`, `bulkWrites`, `writes`, `records`, `reset()`.

- [ ] **Step 1: Add the types and helpers the tests import**

In `lib/types.ts`, replace `Bookmark` and add the batch patch types after it:

```ts
export interface Bookmark {
  id: string;
  title: string;
  url: string;
  description: string;
  /** Plain-text notes; a missing value means "". */
  notes?: string;
  favicon: string;
  collectionId: string;
  tags: string[]; // tag IDs
  createdAt: string;
  /** Unix ms of the user's last change; missing for bookmarks saved before edit times existed. */
  updatedAt?: number;
  isFavorite: boolean;
  hasDarkIcon?: boolean;
  seq: number;
  deletedAt?: number;
}

/** The fields a batch update may change. */
export type BookmarkBatchPatch = Partial<
  Pick<Bookmark, "title" | "url" | "description" | "notes" | "collectionId" | "tags" | "isFavorite">
>;

export interface BookmarkPatchEntry {
  id: string;
  patch: BookmarkBatchPatch;
}
```

In `lib/api.ts`, add to `ServerBookmark` after `description?: string;`:

```ts
  /** Absent when the server predates notes. */
  notes?: string;
```

and after `updated_at: number;`:

```ts
  /** The client-reported time of the user's last edit; absent from older servers and older rows. */
  edited_at?: number;
```

In `lib/bookmark-utils.ts`, add after `bookmarkCreatedAtTime`:

```ts
/** The longest note a bookmark may carry, in UTF-16 code units (what `maxLength` counts). */
export const MAX_BOOKMARK_NOTES_LENGTH = 10_000;

/**
 * When the user last changed a bookmark. Bookmarks saved before edit times
 * existed report their creation time.
 */
export function bookmarkEditedAt(updatedAt: number | undefined, createdAt: string): number {
  return updatedAt ?? bookmarkCreatedAtTime(createdAt);
}
```

- [ ] **Step 2: Write the store test harness**

Create `test/helpers/bookmarks-store-harness.ts`:

```ts
import type { StateStorage } from "zustand/middleware";
import type { SyncPushEntities } from "@/lib/api";
import type { BulkWriteOp } from "@/lib/idb";
import { importFresh, type ModuleReplacer } from "./module-replacer";

export interface RecordedWrite {
  type: "put" | "delete";
  store: string;
  key: string;
}

export interface BookmarksStoreHarness {
  useBookmarksStore: typeof import("@/store/bookmarks-store").useBookmarksStore;
  usePlanStore: typeof import("@/store/plan-store").usePlanStore;
  /** Payloads handed to syncEngine.enqueue, oldest first. */
  enqueued: Array<Partial<SyncPushEntities>>;
  /** The operations of each idbBulkWrite call, oldest first. */
  bulkWrites: BulkWriteOp[][];
  /** idbPut and idbDelete calls, oldest first. */
  writes: RecordedWrite[];
  /** What the fake IndexedDB returns from reads: store name, then key. */
  records: Map<string, Map<string, object>>;
  /** Clears the recordings and records, and empties the store with every bucket loaded. */
  reset: () => void;
}

function createMemoryStorage(): StateStorage {
  const items = new Map<string, string>();
  return {
    getItem: async (name) => items.get(name) ?? null,
    setItem: async (name, value) => {
      items.set(name, value);
    },
    removeItem: async (name) => {
      items.delete(name);
    },
  };
}

function recordKey(value: object): string {
  const id = Reflect.get(value, "id");
  return typeof id === "string" ? id : String(Reflect.get(value, "key"));
}

/**
 * Loads a fresh bookmarks store whose IndexedDB and sync engine are fakes that
 * record every write, so tests can count transactions and enqueues.
 */
export async function installBookmarksStoreHarness(replacer: ModuleReplacer): Promise<BookmarksStoreHarness> {
  const enqueued: Array<Partial<SyncPushEntities>> = [];
  const bulkWrites: BulkWriteOp[][] = [];
  const writes: RecordedWrite[] = [];
  const records = new Map<string, Map<string, object>>();
  const storeRecords = (store: string): Map<string, object> => records.get(store) ?? new Map<string, object>();

  const realIdb = await importFresh<typeof import("@/lib/idb")>("lib/idb.ts");
  await replacer.replace("@/lib/idb", {
    ...realIdb,
    idbGet: async (store: string, key: IDBValidKey) => storeRecords(store).get(String(key)),
    idbGetAll: async (store: string) => [...storeRecords(store).values()],
    idbGetByIndex: async (store: string, index: string, value: IDBValidKey) =>
      [...storeRecords(store).values()].filter((record) => Reflect.get(record, index) === value),
    idbGetMany: async (store: string, keys: IDBValidKey[]) => keys.map((key) => storeRecords(store).get(String(key))),
    idbPut: async (store: string, value: object) => {
      writes.push({ type: "put", store, key: recordKey(value) });
    },
    idbDelete: async (store: string, key: IDBValidKey) => {
      writes.push({ type: "delete", store, key: String(key) });
    },
    idbBulkWrite: async (ops: BulkWriteOp[]) => {
      bulkWrites.push(ops);
    },
  });
  // The conflict registry starts reading IndexedDB when its module loads. A copy
  // another test file loaded may still wait on the inert IndexedDB stub forever.
  await replacer.replace(
    "@/lib/sync-conflicts",
    await importFresh<typeof import("@/lib/sync-conflicts")>("lib/sync-conflicts.ts"),
  );
  await replacer.replace("@/lib/chrome-storage-adapter", { chromeStorageAdapter: createMemoryStorage() });
  const planStore = await importFresh<typeof import("@/store/plan-store")>("store/plan-store.ts");
  await replacer.replace("@/store/plan-store", planStore);
  const realSyncEngine = await importFresh<typeof import("@/lib/sync-engine")>("lib/sync-engine.ts");
  await replacer.replace("@/lib/sync-engine", {
    ...realSyncEngine,
    syncEngine: {
      enqueue: (entities: Partial<SyncPushEntities>) => {
        enqueued.push(entities);
      },
      forcePush: async () => {},
    },
  });
  const bookmarksStore = await importFresh<typeof import("@/store/bookmarks-store")>("store/bookmarks-store.ts");
  await replacer.replace("@/store/bookmarks-store", bookmarksStore);

  const { useBookmarksStore } = bookmarksStore;
  const { usePlanStore } = planStore;
  return {
    useBookmarksStore,
    usePlanStore,
    enqueued,
    bulkWrites,
    writes,
    records,
    reset: () => {
      enqueued.length = 0;
      bulkWrites.length = 0;
      writes.length = 0;
      records.clear();
      // A fresh fetch time keeps ensureFresh() from reaching for the network.
      usePlanStore.setState({ limits: null, usage: null, fetchedAt: Date.now() });
      useBookmarksStore.setState({
        bookmarks: new Map(),
        countsByCollection: {},
        archivedBookmarks: [],
        trashedBookmarks: [],
        _archivedLoaded: true,
        _trashedLoaded: true,
        selectedCollection: "all",
        selectedTags: [],
        searchQuery: "",
        filterType: "all",
        sortBy: "date-newest",
      });
    },
  };
}
```

- [ ] **Step 3: Write the failing tests**

Create `test/bookmark-sync-fields.test.ts`:

```ts
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import type { ServerBookmark, SyncEntity } from "@/lib/api";
import type { Bookmark } from "@/lib/types";
import { createModuleReplacer } from "./helpers/module-replacer";
import { setupDom, teardownDom } from "./helpers/dom-environment";
import { installBookmarksStoreHarness, type BookmarksStoreHarness } from "./helpers/bookmarks-store-harness";
import { bookmarkMap, countsByCollection, makeBookmark } from "./helpers/library-fixtures";

const NOW = 50_000;
const replacer = createModuleReplacer();
let harness: BookmarksStoreHarness;

beforeAll(async () => {
  setupDom();
  harness = await installBookmarksStoreHarness(replacer);
});
afterAll(async () => {
  replacer.restore();
  await teardownDom();
});
beforeEach(() => {
  harness.reset();
  setSystemTime(new Date(NOW));
});
afterEach(() => {
  setSystemTime();
});

function store() {
  return harness.useBookmarksStore.getState();
}

function seed(bookmarks: Bookmark[], buckets: { archived?: Bookmark[]; trashed?: Bookmark[] } = {}): void {
  harness.useBookmarksStore.setState({
    bookmarks: bookmarkMap(bookmarks),
    countsByCollection: countsByCollection(bookmarks),
    archivedBookmarks: buckets.archived ?? [],
    trashedBookmarks: buckets.trashed ?? [],
  });
}

function pushedBookmarks(): SyncEntity[] {
  return harness.enqueued.flatMap((entities) => entities.bookmarks ?? []);
}

function serverBookmark(id: string, overrides: Partial<ServerBookmark> = {}): ServerBookmark {
  return {
    id,
    user_id: "user",
    collection_id: "reading",
    title: id,
    url: `https://example.com/${id}`,
    is_favorite: false,
    is_archived: false,
    is_trashed: 0,
    tag_ids: [],
    position: 0,
    seq: 7,
    created_at: 1_000,
    updated_at: 9_000,
    ...overrides,
  };
}

async function merge(bookmarks: ServerBookmark[]): Promise<void> {
  await store().mergeFromServer({
    entities: { workspaces: [], collections: [], bookmarks, tags: [], groups: [] },
    server_seq: 10,
  });
}

describe("edit time", () => {
  test("adding a bookmark stamps it and pushes its notes and edit time", () => {
    const added = store().addBookmark({
      title: "Docs", url: "https://docs.example.com", description: "", notes: "Read later",
      favicon: "", collectionId: "reading", tags: [], seq: 0,
    });
    expect(added.updatedAt).toBe(NOW);
    const [entity] = pushedBookmarks();
    expect(entity?.notes).toBe("Read later");
    expect(entity?.edited_at).toBe(NOW);
  });

  test("bulk adds and imports stamp every bookmark", () => {
    store().addBookmarks([makeBookmark("dropped", { collectionId: "reading" })]);
    store()._bulkAddBookmarks([makeBookmark("imported", { collectionId: "reading" })]);
    expect(store().bookmarks.get("dropped")?.updatedAt).toBe(NOW);
    expect(store().bookmarks.get("imported")?.updatedAt).toBe(NOW);
  });

  test("editing, favoriting, archiving, trashing and restoring stamp the edit time", () => {
    const stale = { collectionId: "reading", updatedAt: 1 };
    seed(
      [makeBookmark("edit", stale), makeBookmark("favorite", stale), makeBookmark("archive", stale), makeBookmark("trash", stale)],
      { archived: [makeBookmark("unarchive", stale)], trashed: [makeBookmark("untrash", { ...stale, deletedAt: 5 })] },
    );

    store().updateBookmark("edit", { title: "Edited" });
    store().toggleFavorite("favorite");
    store().archiveBookmark("archive");
    store().trashBookmark("trash");
    store().restoreFromArchive("unarchive");
    store().restoreFromTrash("untrash");

    const state = store();
    expect(state.bookmarks.get("edit")?.updatedAt).toBe(NOW);
    expect(state.bookmarks.get("favorite")?.updatedAt).toBe(NOW);
    expect(state.archivedBookmarks.find((bookmark) => bookmark.id === "archive")?.updatedAt).toBe(NOW);
    expect(state.trashedBookmarks.find((bookmark) => bookmark.id === "trash")?.updatedAt).toBe(NOW);
    expect(state.bookmarks.get("unarchive")?.updatedAt).toBe(NOW);
    expect(state.bookmarks.get("untrash")?.updatedAt).toBe(NOW);
    expect(pushedBookmarks().every((entity) => entity.edited_at === NOW)).toBe(true);
  });

  test("a sweep pushes legacy bookmarks with their creation time and empty notes, without stamping them", async () => {
    seed([
      makeBookmark("legacy", { collectionId: "reading", createdAt: "2026-01-01T00:00:00.000Z" }),
      makeBookmark("epoch", { collectionId: "reading", createdAt: "1748390400000" }),
    ]);

    await store().sweepUnsynced();

    expect(pushedBookmarks().map((entity) => [entity.id, entity.notes, entity.edited_at])).toEqual([
      ["legacy", "", Date.parse("2026-01-01T00:00:00.000Z")],
      ["epoch", "", 1748390400000],
    ]);
    expect(store().bookmarks.get("legacy")?.updatedAt).toBeUndefined();
  });
});

describe("mergeFromServer", () => {
  test("takes notes and the edit time from a server that sends them", async () => {
    seed([makeBookmark("b1", { collectionId: "reading", notes: "local", updatedAt: 3 })]);
    await merge([serverBookmark("b1", { notes: "remote", edited_at: 4_000 })]);
    expect(store().bookmarks.get("b1")?.notes).toBe("remote");
    expect(store().bookmarks.get("b1")?.updatedAt).toBe(4_000);
  });

  test("keeps local notes when the server sends none and falls back to its updated_at", async () => {
    seed([makeBookmark("b1", { collectionId: "reading", notes: "local", updatedAt: 3 })]);
    await merge([serverBookmark("b1")]);
    expect(store().bookmarks.get("b1")?.notes).toBe("local");
    expect(store().bookmarks.get("b1")?.updatedAt).toBe(9_000);
  });

  test("an empty note from the server clears the local one", async () => {
    seed([makeBookmark("b1", { collectionId: "reading", notes: "local" })]);
    await merge([serverBookmark("b1", { notes: "" })]);
    expect(store().bookmarks.get("b1")?.notes).toBe("");
  });
});

describe("push confirmation", () => {
  function entityFor(bookmark: Bookmark): SyncEntity {
    return {
      id: bookmark.id,
      collection_id: bookmark.collectionId || null,
      title: bookmark.title,
      url: bookmark.url,
      favicon_url: bookmark.favicon,
      description: bookmark.description,
      notes: bookmark.notes ?? "",
      is_favorite: bookmark.isFavorite,
      is_archived: false,
      is_trashed: 0,
      tag_ids: bookmark.tags,
      position: 0,
      seq: bookmark.seq,
      deleted_at: null,
      updated_at: 1,
      edited_at: bookmark.updatedAt ?? 0,
    };
  }

  test("a push of older notes or an older edit time does not confirm the newer local bookmark", () => {
    const current = makeBookmark("b1", { collectionId: "reading", notes: "new", updatedAt: 200 });
    seed([current]);

    store().confirmBookmarkEntitySeqs([entityFor({ ...current, notes: "old" })], 42);
    expect(store().bookmarks.get("b1")?.seq).toBe(0);
    store().confirmBookmarkEntitySeqs([entityFor({ ...current, updatedAt: 100 })], 42);
    expect(store().bookmarks.get("b1")?.seq).toBe(0);
    store().confirmBookmarkEntitySeqs([entityFor(current)], 42);
    expect(store().bookmarks.get("b1")?.seq).toBe(42);
  });
});

test("search also matches notes", () => {
  seed([
    makeBookmark("noted", { collectionId: "reading", notes: "Kubernetes deep dive" }),
    makeBookmark("plain", { collectionId: "reading" }),
  ]);
  harness.useBookmarksStore.setState({ searchQuery: "kubernetes" });
  expect(store().getFilteredBookmarks(new Set(["reading"])).map((bookmark) => bookmark.id)).toEqual(["noted"]);
});
```

In `test/sync-confirmation.test.ts`, give the bookmark cases the fields a push now carries. Replace the `pushed` line of the bookmark cases:

```ts
    pushed: { id: store, collection_id: "c", title: "Page", url: "https://example.test", favicon_url: "icon", description: "d", notes: "", is_favorite: true, is_archived: store === "archived-bookmarks", is_trashed: store === "trashed-bookmarks" ? 1 : 0, tag_ids: ["t"], position: 0, seq: 0, updated_at: 99, edited_at: Date.parse("2026-01-01"), deleted_at: null },
```

and add this test inside `describe("sync confirmation", …)`:

```ts
  test("bookmark notes and edit time must match the stored bookmark", () => {
    const bookmark = cases.find((confirmationCase) => confirmationCase.store === "bookmarks");
    if (!bookmark) {
      throw new Error("bookmark fixture is missing");
    }
    const { store, persisted, pushed } = bookmark;
    expect(matchesPersistedSyncEntity(store, { ...persisted, notes: "local" }, pushed, [], [])).toBe(false);
    expect(matchesPersistedSyncEntity(store, { ...persisted, notes: "local" }, { ...pushed, notes: "local" }, [], [])).toBe(true);
    expect(matchesPersistedSyncEntity(store, { ...persisted, updatedAt: 5 }, pushed, [], [])).toBe(false);
    expect(matchesPersistedSyncEntity(store, { ...persisted, updatedAt: 5 }, { ...pushed, edited_at: 5 }, [], [])).toBe(true);
  });
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `bun test test/bookmark-sync-fields.test.ts test/sync-confirmation.test.ts`
Expected: FAIL — e.g. `expect(received).toBe(expected) Expected: 50000 Received: undefined` for the stamping tests, `edited_at` missing from pushed entities, merges ignoring notes, and the new confirmation test failing because `matchesPersistedSyncEntity` still returns true for mismatched notes. The canonical confirmation cases still pass: they only gained fields that nothing compares yet.

- [ ] **Step 5: Map, compare and search the new fields**

In `store/bookmarks-store.ts`, extend the bookmark-utils import:

```ts
import {
  bookmarkEditedAt,
  compareBookmarksNewestFirst,
  compareBookmarksTrashedFirst,
  normalizeFavicon,
} from "@/lib/bookmark-utils";
```

In `toServerBookmark`, add after `description: b.description,`:

```ts
    notes: b.notes ?? "",
```

and after `updated_at: Date.now(),`:

```ts
    edited_at: bookmarkEditedAt(b.updatedAt, b.createdAt),
```

In `bookmarkMatchesSyncEntity`, add after `entity.description === bookmark.description &&`:

```ts
    (entity.notes ?? "") === (bookmark.notes ?? "") &&
    entity.edited_at === bookmarkEditedAt(bookmark.updatedAt, bookmark.createdAt) &&
```

In `applySearch`, match notes too:

```ts
  return bookmarks.filter(
    (b) =>
      b.title.toLowerCase().includes(lower) ||
      b.description.toLowerCase().includes(lower) ||
      b.url.toLowerCase().includes(lower) ||
      (b.notes ?? "").toLowerCase().includes(lower)
  );
```

In `mergeFromServer`, the merged object becomes:

```ts
          const merged: Bookmark = {
            id: serverBookmark.id,
            title: serverBookmark.title,
            url: serverBookmark.url,
            description: serverBookmark.description ?? existing?.description ?? "",
            // A server that predates notes sends none; never clear local notes for that.
            notes: serverBookmark.notes ?? existing?.notes ?? "",
            favicon: normalizeFavicon(serverBookmark.favicon_url, serverBookmark.url),
            collectionId: serverBookmark.collection_id ?? existing?.collectionId ?? "",
            tags: serverBookmark.tag_ids ?? existing?.tags ?? [],
            createdAt: existing?.createdAt ?? serverCreatedAtToIso(serverBookmark.created_at),
            updatedAt: serverBookmark.edited_at ?? serverBookmark.updated_at ?? existing?.updatedAt,
            isFavorite: serverBookmark.is_favorite,
            seq: keepLocallyTrashed ? (existing?.seq ?? 0) : serverBookmark.seq,
            deletedAt: localDeletedAt,
          };
```

In `lib/sync-confirmation.ts`, import the helper and compare the fields in `matchesBookmark`:

```ts
import { bookmarkEditedAt } from "@/lib/bookmark-utils";
```

```ts
    readString(record, "description") === entity.description &&
    (readString(record, "notes") ?? "") === (entity.notes ?? "") &&
    entity.edited_at === bookmarkEditedAt(readNumber(record, "updatedAt"), readString(record, "createdAt") ?? "") &&
    readBoolean(record, "isFavorite") === entity.is_favorite &&
```

- [ ] **Step 6: Stamp the edit time on every user change**

Still in `store/bookmarks-store.ts`. Collection cascades (`archiveCollectionBookmarks`, `trashCollectionBookmarks`, `restoreCollectionBookmarks`), `reassignCollection`, trash expiry, merges, sweeps and confirmations stay unstamped.

`addBookmark` — stamp after the spread:

```ts
          const bookmark: Bookmark = {
            id: generateId(),
            createdAt: new Date().toISOString(),
            isFavorite: false,
            ...input,
            favicon: normalizeFavicon(input.favicon, input.url),
            updatedAt: Date.now(),
          };
```

`addBookmarks` and `_bulkAddBookmarks` — replace each `const normalized = …` line with:

```ts
        const addedAt = Date.now();
        const normalized = newBookmarks.map((b) => ({ ...b, favicon: normalizeFavicon(b.favicon, b.url), updatedAt: addedAt }));
```

`updateBookmark` — add `const editedAt = Date.now();` as its first line and stamp all five branches: `{ ...activeBookmark, ...patch, updatedAt: editedAt }`, `{ ...archivedBookmark, ...patch, updatedAt: editedAt }`, `{ ...trashedBookmark, ...patch, updatedAt: editedAt }`, `{ ...archived, ...patch, updatedAt: editedAt }` and `{ ...trashed, ...patch, updatedAt: editedAt }`.

`toggleFavorite`:

```ts
        const updated = { ...bookmark, isFavorite: !bookmark.isFavorite, updatedAt: Date.now() };
```

`archiveBookmark` — archive a stamped copy:

```ts
      archiveBookmark: (bookmarkId) => {
        const bookmark = get().bookmarks.get(bookmarkId);
        if (!bookmark) { return; }
        const archived = { ...bookmark, updatedAt: Date.now() };
        idbDelete("bookmarks", bookmarkId);
        idbPut("archived-bookmarks", archived);
        syncEngine?.enqueue({ bookmarks: [toServerBookmark(archived, { isArchived: true })] });
        set((state) => {
          const nextBookmarks = new Map(state.bookmarks);
          nextBookmarks.delete(bookmarkId);
          const nextCounts = { ...state.countsByCollection };
          decrementCollectionCount(nextCounts, bookmark.collectionId);
          return {
            bookmarks: nextBookmarks,
            countsByCollection: nextCounts,
            archivedBookmarks: state._archivedLoaded ? [...state.archivedBookmarks, archived] : state.archivedBookmarks,
          };
        });
        assertCountsInvariant(get());
      },
```

`restoreFromArchive` — in the loaded branch replace `if (bookmark) {` and every following use of `bookmark` with a stamped `restored`:

```ts
        if (bookmark) {
          const restored = { ...bookmark, updatedAt: Date.now() };
          idbDelete("archived-bookmarks", bookmarkId);
          idbPut("bookmarks", restored);
          syncEngine?.enqueue({ bookmarks: [toServerBookmark(restored)] });
          set((current) => {
            const nextBookmarks = new Map(current.bookmarks);
            nextBookmarks.set(restored.id, restored);
            const nextCounts = { ...current.countsByCollection };
            incrementCollectionCount(nextCounts, restored.collectionId);
            return {
              archivedBookmarks: current.archivedBookmarks.filter((candidate) => candidate.id !== bookmarkId),
              bookmarks: nextBookmarks,
              countsByCollection: nextCounts,
            };
          });
          assertCountsInvariant(get());
          return;
        }
```

and in the IndexedDB branch, after `if (!archived) { return; }`, add `const restored = { ...archived, updatedAt: Date.now() };` and use `restored` instead of `archived` in the `idbPut`, the enqueue and the `set` updater.

`trashBookmark`:

```ts
        const trashedAt = Date.now();
        const trashed = { ...bookmark, deletedAt: trashedAt, updatedAt: trashedAt };
```

`restoreFromTrash` — both branches build `restored` with the stamp:

```ts
          const restored = collectionIdOverride !== undefined
            ? { ...bookmark, collectionId: collectionIdOverride, deletedAt: undefined, updatedAt: Date.now() }
            : { ...bookmark, deletedAt: undefined, updatedAt: Date.now() };
```

```ts
          const restored = collectionIdOverride !== undefined
            ? { ...trashed, collectionId: collectionIdOverride, deletedAt: undefined, updatedAt: Date.now() }
            : { ...trashed, deletedAt: undefined, updatedAt: Date.now() };
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test test/bookmark-sync-fields.test.ts test/sync-confirmation.test.ts && bun run compile`
Expected: all tests pass; `tsc` exits 0.

- [ ] **Step 8: Run the store suites**

Run: `bun test test/bookmarks-store-batch.test.js test/bookmarks-store-offline.test.js test/bookmarks-store-sort.test.js test/sync-pull-persistence.test.js test/sync-engine-ordering.test.js test/guest-workspace.test.js`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add lib/types.ts lib/api.ts lib/bookmark-utils.ts lib/sync-confirmation.ts store/bookmarks-store.ts test/helpers/bookmarks-store-harness.ts test/bookmark-sync-fields.test.ts test/sync-confirmation.test.ts
git commit -m "feat(bookmarks): sync notes and the edit time

Every user change stamps updatedAt; pushes carry notes and
edited_at, merges keep local notes from servers without them, and
confirmations compare both fields. Search also matches notes.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Byte-limited push chunks

**Files:**
- Modify: `lib/sync-recovery.ts` (`MAX_SYNC_ENTITIES_PER_PUSH` line 10; `splitSyncPushPayload` lines 76–116)
- Test: `test/sync-push-split.test.ts` (new)

**Interfaces:**
- Produces: `MAX_SYNC_PUSH_BYTES = 384 * 1024`; `splitSyncPushPayload(full)` keeps returning `[full]` when the payload fits both limits, and otherwise returns ordered chunks (non-bookmark entities first, then bookmarks) of at most 900 entities and 384 KB each, an oversized entity alone.

- [ ] **Step 1: Write the failing tests**

Create `test/sync-push-split.test.ts`:

```ts
// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import type { SyncEntity, SyncPushPayload } from "@/lib/api";
import { importFresh } from "./helpers/module-replacer";

const {
  MAX_SYNC_ENTITIES_PER_PUSH,
  MAX_SYNC_PUSH_BYTES,
  createEmptySyncPushPayload,
  splitSyncPushPayload,
} = await importFresh<typeof import("@/lib/sync-recovery")>("lib/sync-recovery.ts");

const ENVELOPE_ALLOWANCE = 200;

function bookmarkEntity(id: string, notes = ""): SyncEntity {
  return { id, collection_id: "c", title: id, url: `https://example.com/${id}`, notes, tag_ids: [], position: 0, seq: 0 };
}

function payloadOf(entities: Partial<SyncPushPayload["entities"]>): SyncPushPayload {
  const payload = createEmptySyncPushPayload();
  Object.assign(payload.entities, entities);
  return payload;
}

function bodyBytes(payload: SyncPushPayload): number {
  return new TextEncoder().encode(JSON.stringify(payload)).length;
}

function chunkContents(chunks: SyncPushPayload[]): string[][] {
  return chunks.map((chunk) =>
    Object.entries(chunk.entities).flatMap(([key, entities]) => entities.map((entity) => `${key}:${entity.id}`)),
  );
}

describe("splitSyncPushPayload", () => {
  test("returns a payload within both limits as it is", () => {
    const payload = payloadOf({ bookmarks: [bookmarkEntity("a")] });
    const chunks = splitSyncPushPayload(payload);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(payload);
  });

  test("splits bookmarks with long notes so every request stays under the byte limit", () => {
    const longNote = "笔".repeat(10_000);
    const bookmarks = Array.from({ length: 20 }, (_, index) => bookmarkEntity(`b${index}`, longNote));

    const chunks = splitSyncPushPayload(payloadOf({ bookmarks }));

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(bodyBytes(chunk)).toBeLessThanOrEqual(MAX_SYNC_PUSH_BYTES + ENVELOPE_ALLOWANCE);
    }
    expect(chunks.flatMap((chunk) => chunk.entities.bookmarks.map((entity) => entity.id))).toEqual(
      bookmarks.map((entity) => entity.id),
    );
  });

  test("keeps non-bookmark entities ahead of bookmarks when it splits", () => {
    const longNote = "x".repeat(200_000);
    const chunks = splitSyncPushPayload(payloadOf({
      collections: [{ id: "c1", name: "One" }],
      tags: [{ id: "t1", name: "Tag" }],
      bookmarks: [bookmarkEntity("b1", longNote), bookmarkEntity("b2", longNote)],
    }));
    expect(chunkContents(chunks)).toEqual([["collections:c1", "tags:t1"], ["bookmarks:b1"], ["bookmarks:b2"]]);
  });

  test("sends an entity over the byte limit on its own", () => {
    const chunks = splitSyncPushPayload(payloadOf({
      bookmarks: [bookmarkEntity("before"), bookmarkEntity("huge", "x".repeat(MAX_SYNC_PUSH_BYTES)), bookmarkEntity("after")],
    }));
    expect(chunks.map((chunk) => chunk.entities.bookmarks.map((entity) => entity.id))).toEqual([["before"], ["huge"], ["after"]]);
  });

  test("still limits each request to the entity count", () => {
    const bookmarks = Array.from({ length: MAX_SYNC_ENTITIES_PER_PUSH + 1 }, (_, index) => bookmarkEntity(`b${index}`));
    const chunks = splitSyncPushPayload(payloadOf({ bookmarks }));
    expect(chunks.map((chunk) => chunk.entities.bookmarks.length)).toEqual([MAX_SYNC_ENTITIES_PER_PUSH, 1]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/sync-push-split.test.ts`
Expected: FAIL — `MAX_SYNC_PUSH_BYTES` is `undefined`, and the long-notes payload comes back as one chunk.

- [ ] **Step 3: Implement byte-limited chunks**

In `lib/sync-recovery.ts`, add after `export const MAX_SYNC_ENTITIES_PER_PUSH = 900;`:

```ts
/**
 * The server answers 413 to a push body over 512 KB, and a 413 is not
 * retried. Chunks stay well below it; the request envelope adds well under 1 KB.
 */
export const MAX_SYNC_PUSH_BYTES = 384 * 1024;

const utf8 = new TextEncoder();

/** An entity's share of a push body: its UTF-8 JSON plus one byte for the separator. */
function syncEntityBytes(entity: SyncEntity): number {
  return utf8.encode(JSON.stringify(entity)).length + 1;
}

/**
 * Groups entries, in order, into chunks of at most MAX_SYNC_ENTITIES_PER_PUSH
 * entities and MAX_SYNC_PUSH_BYTES. An entity over the byte limit on its own
 * gets a chunk to itself, and the server's answer to it decides what happens.
 */
function chunkSyncEntries<T>(entries: readonly T[], entityOf: (entry: T) => SyncEntity): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const entry of entries) {
    const bytes = syncEntityBytes(entityOf(entry));
    const full = current.length >= MAX_SYNC_ENTITIES_PER_PUSH || currentBytes + bytes > MAX_SYNC_PUSH_BYTES;
    if (current.length > 0 && full) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(entry);
    currentBytes += bytes;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}
```

Replace `splitSyncPushPayload`:

```ts
export function splitSyncPushPayload(full: SyncPushPayload): SyncPushPayload[] {
  const { workspaces, collections, bookmarks, tags, groups } = full.entities;
  const all: SyncEntity[] = [...workspaces, ...collections, ...bookmarks, ...tags, ...groups];
  const totalBytes = all.reduce((sum, entity) => sum + syncEntityBytes(entity), 0);
  if (all.length <= MAX_SYNC_ENTITIES_PER_PUSH && totalBytes <= MAX_SYNC_PUSH_BYTES) {
    return [full];
  }
  const chunks: SyncPushPayload[] = [];
  interface NonBookmarkEntry {
    payloadKey: "workspaces" | "collections" | "tags" | "groups";
    entity: SyncEntity;
  }
  const entries = (
    payloadKey: NonBookmarkEntry["payloadKey"],
    entities: SyncEntity[],
  ): NonBookmarkEntry[] => entities.map((entity) => ({ payloadKey, entity }));
  // Parents travel before bookmarks so the server can resolve them.
  const nonBookmarks: NonBookmarkEntry[] = [
    ...entries("workspaces", workspaces),
    ...entries("collections", collections),
    ...entries("tags", tags),
    ...entries("groups", groups),
  ];
  for (const group of chunkSyncEntries(nonBookmarks, (entry) => entry.entity)) {
    const chunk = createEmptySyncPushPayload();
    for (const { payloadKey, entity } of group) {
      syncPayloadEntities(chunk, payloadKey).push(entity);
    }
    chunks.push(chunk);
  }
  for (const group of chunkSyncEntries(bookmarks, (entity) => entity)) {
    const chunk = createEmptySyncPushPayload();
    chunk.entities.bookmarks.push(...group);
    chunks.push(chunk);
  }
  return chunks;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/sync-push-split.test.ts test/sync-queue.test.js test/sync-recovery.test.js test/sync-engine-deferred-capture.test.js && bun run compile`
Expected: all pass; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add lib/sync-recovery.ts test/sync-push-split.test.ts
git commit -m "fix(sync): keep push chunks under the server's body limit

Chunks were split only by entity count, so twenty bookmarks with
long notes could exceed 512 KB and be refused with 413.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Batch store actions

**Files:**
- Modify: `store/bookmarks-store.ts` (imports; state interface; helpers near `stringArraysEqual`; new actions after `updateBookmark`, `archiveBookmark` and `trashBookmark`)
- Test: `test/bookmarks-batch-actions.test.ts` (new)

**Interfaces:**
- Consumes: `BookmarkBatchPatch`, `BookmarkPatchEntry` (Task 3); `installBookmarksStoreHarness` (Task 3).
- Produces on `useBookmarksStore`: `updateBookmarks(patches: readonly BookmarkPatchEntry[]): void`, `archiveBookmarks(ids: readonly string[]): void`, `trashBookmarks(ids: readonly string[]): void`. Each acts on active bookmarks only, skips unknown or inactive IDs, and performs at most one `set()`, one `idbBulkWrite` and one `syncEngine?.enqueue()`.

- [ ] **Step 1: Write the failing tests**

Create `test/bookmarks-batch-actions.test.ts`:

```ts
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import type { BulkWriteOp } from "@/lib/idb";
import type { Bookmark } from "@/lib/types";
import { createModuleReplacer } from "./helpers/module-replacer";
import { setupDom, teardownDom } from "./helpers/dom-environment";
import { installBookmarksStoreHarness, type BookmarksStoreHarness } from "./helpers/bookmarks-store-harness";
import { bookmarkMap, countsByCollection, makeBookmark } from "./helpers/library-fixtures";

const NOW = 60_000;
const replacer = createModuleReplacer();
let harness: BookmarksStoreHarness;

beforeAll(async () => {
  setupDom();
  harness = await installBookmarksStoreHarness(replacer);
});
afterAll(async () => {
  replacer.restore();
  await teardownDom();
});
beforeEach(() => {
  harness.reset();
  setSystemTime(new Date(NOW));
});
afterEach(() => {
  setSystemTime();
});

function store() {
  return harness.useBookmarksStore.getState();
}

function seed(bookmarks: Bookmark[]): void {
  harness.useBookmarksStore.setState({ bookmarks: bookmarkMap(bookmarks), countsByCollection: countsByCollection(bookmarks) });
}

function describeOps(ops: BulkWriteOp[]): string[] {
  return ops.map((op) => (op.type === "put" ? `put ${op.store} ${String(Reflect.get(op.value, "id"))}` : `delete ${op.store} ${String(op.key)}`));
}

const reading = { collectionId: "reading", updatedAt: 1 };

describe("updateBookmarks", () => {
  test("applies every change in one state update, one transaction and one enqueue", () => {
    seed([
      makeBookmark("a", reading),
      makeBookmark("b", reading),
      makeBookmark("c", { collectionId: "projects", updatedAt: 1 }),
    ]);
    const before = store().bookmarks;

    store().updateBookmarks([
      { id: "a", patch: { collectionId: "projects" } },
      { id: "b", patch: { collectionId: "reading" } },
      { id: "c", patch: { tags: ["t1"], isFavorite: false } },
      { id: "missing", patch: { title: "Missing" } },
    ]);

    const state = store();
    expect(state.bookmarks).not.toBe(before);
    expect(state.bookmarks.get("a")?.collectionId).toBe("projects");
    expect(state.bookmarks.get("a")?.updatedAt).toBe(NOW);
    expect(state.bookmarks.get("b")?.updatedAt).toBe(1);
    expect(state.bookmarks.get("c")?.tags).toEqual(["t1"]);
    expect(state.bookmarks.get("c")?.updatedAt).toBe(NOW);
    expect(state.countsByCollection).toEqual({ reading: 1, projects: 2 });
    expect(harness.bulkWrites.map(describeOps)).toEqual([["put bookmarks a", "put bookmarks c"]]);
    expect(harness.enqueued.map((entities) => entities.bookmarks?.map((entity) => entity.id))).toEqual([["a", "c"]]);
    expect(harness.enqueued[0]?.bookmarks?.every((entity) => entity.edited_at === NOW)).toBe(true);
  });

  test("a batch that changes nothing writes nothing", () => {
    seed([makeBookmark("a", reading)]);
    const before = store().bookmarks;

    store().updateBookmarks([{ id: "a", patch: { title: "a", notes: "", tags: [] } }]);

    expect(store().bookmarks).toBe(before);
    expect(harness.bulkWrites).toEqual([]);
    expect(harness.enqueued).toEqual([]);
  });
});

describe("archiveBookmarks", () => {
  test("moves active bookmarks to the loaded archive in one transaction and pushes them as archived", () => {
    seed([makeBookmark("a", reading), makeBookmark("b", reading), makeBookmark("c", reading)]);

    store().archiveBookmarks(["a", "b", "a", "missing"]);

    const state = store();
    expect([...state.bookmarks.keys()]).toEqual(["c"]);
    expect(state.countsByCollection).toEqual({ reading: 1 });
    expect(state.archivedBookmarks.map((bookmark) => [bookmark.id, bookmark.updatedAt])).toEqual([["a", NOW], ["b", NOW]]);
    expect(harness.bulkWrites.map(describeOps)).toEqual([[
      "delete bookmarks a", "put archived-bookmarks a",
      "delete bookmarks b", "put archived-bookmarks b",
    ]]);
    expect(harness.enqueued).toHaveLength(1);
    expect(harness.enqueued[0]?.bookmarks?.map((entity) => [entity.id, entity.is_archived])).toEqual([["a", true], ["b", true]]);
  });

  test("leaves an archive that is not loaded alone and writes IndexedDB only", () => {
    seed([makeBookmark("a", reading)]);
    const unloaded: Bookmark[] = [];
    harness.useBookmarksStore.setState({ _archivedLoaded: false, archivedBookmarks: unloaded });

    store().archiveBookmarks(["a"]);

    expect(store().archivedBookmarks).toBe(unloaded);
    expect(harness.bulkWrites.map(describeOps)).toEqual([["delete bookmarks a", "put archived-bookmarks a"]]);
  });
});

describe("trashBookmarks", () => {
  test("trashes active bookmarks in one transaction, pushes them as trashed and moves usage once", () => {
    seed([makeBookmark("a", reading), makeBookmark("b", reading)]);
    const moves: Array<[string, number | undefined]> = [];
    const originalMove = harness.usePlanStore.getState().moveUsageToTrash;
    harness.usePlanStore.setState({ moveUsageToTrash: (resource, by) => { moves.push([resource, by]); } });
    try {
      store().trashBookmarks(["a", "b", "missing"]);
    } finally {
      harness.usePlanStore.setState({ moveUsageToTrash: originalMove });
    }

    const state = store();
    expect(state.bookmarks.size).toBe(0);
    expect(state.countsByCollection).toEqual({});
    expect(state.trashedBookmarks.map((bookmark) => [bookmark.id, bookmark.deletedAt, bookmark.updatedAt])).toEqual([
      ["a", NOW, NOW],
      ["b", NOW, NOW],
    ]);
    expect(harness.bulkWrites.map(describeOps)).toEqual([[
      "delete bookmarks a", "put trashed-bookmarks a",
      "delete bookmarks b", "put trashed-bookmarks b",
    ]]);
    expect(harness.enqueued[0]?.bookmarks?.map((entity) => [entity.id, entity.is_trashed, entity.deleted_at])).toEqual([
      ["a", 1, null],
      ["b", 1, null],
    ]);
    expect(moves).toEqual([["bookmark", 2]]);
  });

  test("leaves a trash that is not loaded alone", () => {
    seed([makeBookmark("a", reading)]);
    const unloaded: Bookmark[] = [];
    harness.useBookmarksStore.setState({ _trashedLoaded: false, trashedBookmarks: unloaded });

    store().trashBookmarks(["a"]);

    expect(store().trashedBookmarks).toBe(unloaded);
    expect(harness.bulkWrites.map(describeOps)).toEqual([["delete bookmarks a", "put trashed-bookmarks a"]]);
  });

  test("does nothing when none of the IDs are active", () => {
    store().trashBookmarks(["missing"]);
    expect(harness.bulkWrites).toEqual([]);
    expect(harness.enqueued).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/bookmarks-batch-actions.test.ts`
Expected: FAIL — `store().updateBookmarks is not a function`.

- [ ] **Step 3: Implement the batch actions**

In `store/bookmarks-store.ts`, import the patch types:

```ts
import type { Bookmark, BookmarkBatchPatch, BookmarkPatchEntry } from "@/lib/types";
```

Add the helpers after `isStringArray`:

```ts
function patchChangesBookmark(bookmark: Bookmark, patch: BookmarkBatchPatch): boolean {
  return (patch.title !== undefined && patch.title !== bookmark.title) ||
    (patch.url !== undefined && patch.url !== bookmark.url) ||
    (patch.description !== undefined && patch.description !== bookmark.description) ||
    (patch.notes !== undefined && patch.notes !== (bookmark.notes ?? "")) ||
    (patch.collectionId !== undefined && patch.collectionId !== bookmark.collectionId) ||
    (patch.tags !== undefined && !stringArraysEqual(patch.tags, bookmark.tags)) ||
    (patch.isFavorite !== undefined && patch.isFavorite !== bookmark.isFavorite);
}

function applyBookmarkPatch(bookmark: Bookmark, patch: BookmarkBatchPatch, editedAt: number): Bookmark {
  return {
    ...bookmark,
    title: patch.title ?? bookmark.title,
    url: patch.url ?? bookmark.url,
    description: patch.description ?? bookmark.description,
    notes: patch.notes ?? bookmark.notes,
    collectionId: patch.collectionId ?? bookmark.collectionId,
    tags: patch.tags ?? bookmark.tags,
    isFavorite: patch.isFavorite ?? bookmark.isFavorite,
    updatedAt: editedAt,
  };
}

/** The active bookmarks among `ids`, each once, in the order given. */
function uniqueActiveBookmarks(bookmarks: Map<string, Bookmark>, ids: readonly string[]): Bookmark[] {
  const result: Bookmark[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const bookmark = bookmarks.get(id);
    if (bookmark && !seen.has(id)) {
      seen.add(id);
      result.push(bookmark);
    }
  }
  return result;
}
```

Add the three signatures to `BookmarksState`, after `updateBookmark`, `archiveBookmark` and `trashBookmark` respectively:

```ts
  /** Applies many per-bookmark changes to active bookmarks; patches that change nothing are dropped. */
  updateBookmarks: (patches: readonly BookmarkPatchEntry[]) => void;
```

```ts
  archiveBookmarks: (ids: readonly string[]) => void;
```

```ts
  trashBookmarks: (ids: readonly string[]) => void;
```

Add the implementations after `updateBookmark`, `archiveBookmark` and `trashBookmark` respectively:

```ts
      updateBookmarks: (patches) => {
        const state = get();
        const editedAt = Date.now();
        const updates = new Map<string, Bookmark>();
        for (const { id, patch } of patches) {
          const current = updates.get(id) ?? state.bookmarks.get(id);
          if (!current || !patchChangesBookmark(current, patch)) {
            continue;
          }
          updates.set(id, applyBookmarkPatch(current, patch, editedAt));
        }
        if (updates.size === 0) { return; }

        const updated = Array.from(updates.values());
        const nextBookmarks = new Map(state.bookmarks);
        const nextCounts = { ...state.countsByCollection };
        for (const bookmark of updated) {
          const previous = state.bookmarks.get(bookmark.id);
          nextBookmarks.set(bookmark.id, bookmark);
          if (previous && previous.collectionId !== bookmark.collectionId) {
            decrementCollectionCount(nextCounts, previous.collectionId);
            incrementCollectionCount(nextCounts, bookmark.collectionId);
          }
        }
        set({ bookmarks: nextBookmarks, countsByCollection: nextCounts });
        assertCountsInvariant(get());
        void idbBulkWrite(
          updated.map((bookmark) => ({ type: "put" as const, store: "bookmarks" as const, value: bookmark })),
        );
        syncEngine?.enqueue({ bookmarks: updated.map((bookmark) => toServerBookmark(bookmark)) });
      },
```

```ts
      archiveBookmarks: (ids) => {
        const state = get();
        const archivedAt = Date.now();
        const archived = uniqueActiveBookmarks(state.bookmarks, ids).map((bookmark) => ({ ...bookmark, updatedAt: archivedAt }));
        if (archived.length === 0) { return; }

        const nextBookmarks = new Map(state.bookmarks);
        const nextCounts = { ...state.countsByCollection };
        for (const bookmark of archived) {
          nextBookmarks.delete(bookmark.id);
          decrementCollectionCount(nextCounts, bookmark.collectionId);
        }
        set({
          bookmarks: nextBookmarks,
          countsByCollection: nextCounts,
          archivedBookmarks: state._archivedLoaded ? [...state.archivedBookmarks, ...archived] : state.archivedBookmarks,
        });
        assertCountsInvariant(get());
        void idbBulkWrite(archived.flatMap((bookmark) => [
          { type: "delete" as const, store: "bookmarks" as const, key: bookmark.id },
          { type: "put" as const, store: "archived-bookmarks" as const, value: bookmark },
        ]));
        syncEngine?.enqueue({ bookmarks: archived.map((bookmark) => toServerBookmark(bookmark, { isArchived: true })) });
      },
```

```ts
      trashBookmarks: (ids) => {
        const state = get();
        const trashedAt = Date.now();
        const trashed = uniqueActiveBookmarks(state.bookmarks, ids)
          .map((bookmark) => ({ ...bookmark, deletedAt: trashedAt, updatedAt: trashedAt }));
        if (trashed.length === 0) { return; }

        const nextBookmarks = new Map(state.bookmarks);
        const nextCounts = { ...state.countsByCollection };
        for (const bookmark of trashed) {
          nextBookmarks.delete(bookmark.id);
          decrementCollectionCount(nextCounts, bookmark.collectionId);
        }
        set({
          bookmarks: nextBookmarks,
          countsByCollection: nextCounts,
          trashedBookmarks: state._trashedLoaded ? [...state.trashedBookmarks, ...trashed] : state.trashedBookmarks,
        });
        assertCountsInvariant(get());
        void idbBulkWrite(trashed.flatMap((bookmark) => [
          { type: "delete" as const, store: "bookmarks" as const, key: bookmark.id },
          { type: "put" as const, store: "trashed-bookmarks" as const, value: bookmark },
        ]));
        syncEngine?.enqueue({ bookmarks: trashed.map((bookmark) => toServerBookmark(bookmark, { isTrashed: 1 })) });
        usePlanStore.getState().moveUsageToTrash("bookmark", trashed.length);
      },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/bookmarks-batch-actions.test.ts test/bookmark-sync-fields.test.ts && bun run compile`
Expected: all pass; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add store/bookmarks-store.ts test/bookmarks-batch-actions.test.ts
git commit -m "feat(bookmarks): batch update, archive and trash actions

Each writes one state update, one IndexedDB transaction and one
sync enqueue, skips bookmarks that are no longer active, and
respects the lazily loaded archive and trash buckets.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Date updated and Website sort orders

**Files:**
- Modify: `lib/view-preferences.ts` (lines 5 and 8)
- Modify: `lib/url-match.ts` (new export after `looseUrlKey`)
- Modify: `lib/bookmark-utils.ts` (new `sortBookmarks`)
- Modify: `store/bookmarks-store.ts` (remove `applySort`; use `sortBookmarks`)
- Modify: `components/dashboard/header.tsx` (`sortOptions`, trigger label)
- Modify: `components/dashboard/favorites-content.tsx` (apply the sort)
- Modify: both `messages.json`
- Test: `test/bookmark-sort.test.ts` (new), `test/url-match.test.ts`, `test/view-preferences.test.ts`, `test/bookmarks-header-subscription.test.tsx`, `test/library-visible-filters.test.tsx`

**Interfaces:**
- Consumes: `bookmarkEditedAt` (Task 3).
- Produces: `BookmarkSortBy` adds `"updated-newest" | "updated-oldest" | "site-az"`; `siteSortKey(url: string): string | null`; `sortBookmarks(bookmarks: readonly Bookmark[], sortBy: BookmarkSortBy): Bookmark[]` (returns a sorted copy).

- [ ] **Step 1: Write the failing tests**

Create `test/bookmark-sort.test.ts`:

```ts
// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import { importFresh } from "./helpers/module-replacer";
import { makeBookmark } from "./helpers/library-fixtures";

// Other test files register partial fakes for lib/bookmark-utils; load a real copy.
const { sortBookmarks } = await importFresh<typeof import("@/lib/bookmark-utils")>("lib/bookmark-utils.ts");

const ids = (bookmarks: ReturnType<typeof sortBookmarks>) => bookmarks.map((bookmark) => bookmark.id);

describe("sortBookmarks by edit time", () => {
  const bookmarks = [
    makeBookmark("old-edit", { createdAt: "2026-01-05T00:00:00.000Z", updatedAt: Date.parse("2026-01-06T00:00:00.000Z") }),
    makeBookmark("never-edited", { createdAt: "2026-01-07T00:00:00.000Z" }),
    makeBookmark("recent-edit", { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: Date.parse("2026-01-09T00:00:00.000Z") }),
    makeBookmark("tie-b", { updatedAt: 1 }),
    makeBookmark("tie-a", { updatedAt: 1 }),
  ];

  test("newest first falls back to the creation time and breaks ties by ID", () => {
    expect(ids(sortBookmarks(bookmarks, "updated-newest"))).toEqual(["recent-edit", "never-edited", "old-edit", "tie-a", "tie-b"]);
  });

  test("oldest first reverses the times and still breaks ties by ID", () => {
    expect(ids(sortBookmarks(bookmarks, "updated-oldest"))).toEqual(["tie-a", "tie-b", "old-edit", "never-edited", "recent-edit"]);
  });
});

describe("sortBookmarks by website", () => {
  test("orders by host without www., then title, then ID, with unparseable addresses last", () => {
    const bookmarks = [
      makeBookmark("note", { title: "Note", url: "notes:offline" }),
      makeBookmark("docs", { title: "Docs", url: "https://docs.example.com/a" }),
      makeBookmark("www-b", { title: "B", url: "https://www.example.com/b" }),
      makeBookmark("apex-a", { title: "A", url: "http://EXAMPLE.com/a" }),
      makeBookmark("alpha", { title: "Z", url: "https://alpha.dev" }),
      makeBookmark("same-2", { title: "Same", url: "https://example.com/2" }),
      makeBookmark("same-1", { title: "Same", url: "https://example.com/1" }),
    ];
    expect(ids(sortBookmarks(bookmarks, "site-az"))).toEqual(["alpha", "docs", "apex-a", "www-b", "same-1", "same-2", "note"]);
  });

  test("returns a sorted copy", () => {
    const bookmarks = [makeBookmark("b", { url: "https://b.example" }), makeBookmark("a", { url: "https://a.example" })];
    const sorted = sortBookmarks(bookmarks, "site-az");
    expect(sorted).not.toBe(bookmarks);
    expect(ids(bookmarks)).toEqual(["b", "a"]);
  });
});
```

Add to `test/url-match.test.ts`: extend the fresh import to `const { strictUrlKey, looseUrlKey, findUrlMatches, siteSortKey } = …`, and append:

```ts
describe("siteSortKey", () => {
  test("lowercases the host and drops a leading www.", () => {
    expect(siteSortKey("https://WWW.Example.com/Path")).toBe("example.com");
  });
  test("keeps subdomains apart", () => {
    expect(siteSortKey("https://docs.example.com")).toBe("docs.example.com");
  });
  test("returns null for an address that is not a web URL", () => {
    expect(siteSortKey("chrome://extensions")).toBeNull();
    expect(siteSortKey("not a url")).toBeNull();
  });
});
```

Add to the `parseViewPrefs` describe in `test/view-preferences.test.ts`:

```ts
  test("keeps the edit time and website orders", () => {
    for (const sortBy of ["updated-newest", "updated-oldest", "site-az"]) {
      expect(viewPrefs.parseViewPrefs({ viewMode: "grid", sortBy, updatedAt: 1 })?.sortBy).toBe(sortBy);
    }
  });
```

Add to `test/bookmarks-header-subscription.test.tsx`, inside its `describe`:

```ts
  test("labels the sort button with the current order's short name", () => {
    act(() => {
      useBookmarksStore.getState().setSortBy("updated-newest");
    });
    const header = renderHeader();
    expect(header.container.textContent).toContain("header_sortShortUpdatedNewest");

    act(() => {
      useBookmarksStore.getState().setSortBy("site-az");
    });
    expect(header.container.textContent).toContain("header_sortShortSite");
    header.unmount();
    act(() => {
      useBookmarksStore.getState().setSortBy("date-newest");
    });
  });
```

Add to `test/library-visible-filters.test.tsx`:

```ts
test("Favorites lists favorites in the current sort order", () => {
  const bookmarks = [
    makeBookmark("zeta", { title: "Zeta", collectionId: "reading", isFavorite: true }),
    makeBookmark("alpha", { title: "Alpha", collectionId: "reading", isFavorite: true }),
  ];
  app.useBookmarksStore.setState({ bookmarks: bookmarkMap(bookmarks), sortBy: "alpha-az" });
  view = render(app, createElement(FavoritesContent));
  const order = () => Array.from(document.querySelectorAll("[data-bookmark-id]")).map((card) => card.getAttribute("data-bookmark-id"));
  expect(order()).toEqual(["alpha", "zeta"]);
  act(() => { app.useBookmarksStore.getState().setSortBy("alpha-za"); });
  expect(order()).toEqual(["zeta", "alpha"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/bookmark-sort.test.ts test/url-match.test.ts test/view-preferences.test.ts test/bookmarks-header-subscription.test.tsx test/library-visible-filters.test.tsx`
Expected: FAIL — `sortBookmarks is not a function`, `siteSortKey is not a function`, `parseViewPrefs` returns `"date-newest"` for the new values, the header shows `header_sortDateNewest`'s first word, and Favorites keeps insertion order.

- [ ] **Step 3: Add the sort values and helpers**

In `lib/view-preferences.ts`:

```ts
export type BookmarkSortBy =
  | "date-newest"
  | "date-oldest"
  | "updated-newest"
  | "updated-oldest"
  | "alpha-az"
  | "alpha-za"
  | "site-az";

const VIEW_MODES: readonly BookmarkViewMode[] = ["grid", "list"];
const SORT_OPTIONS: readonly BookmarkSortBy[] = [
  "date-newest",
  "date-oldest",
  "updated-newest",
  "updated-oldest",
  "alpha-az",
  "alpha-za",
  "site-az",
];
```

In `lib/url-match.ts`, add after `looseUrlKey`:

```ts
/**
 * The site part of a sort by website: the host, lowercased, without a leading
 * "www.". Subdomains stay separate sites. Null for an address that is not a web URL.
 */
export function siteSortKey(url: string): string | null {
  const parsed = parseWebUrl(url);
  return parsed ? parsed.hostname.replace(/^www\./, "") : null;
}
```

In `lib/bookmark-utils.ts`, extend the imports and add the sort after `compareBookmarksTrashedFirst`:

```ts
import type { Bookmark } from "@/lib/types";
import type { BookmarkSortBy } from "@/lib/view-preferences";
import { siteSortKey, strictUrlKey } from "@/lib/url-match";
```

```ts
function compareIds(a: Bookmark, b: Bookmark): number {
  return a.id.localeCompare(b.id);
}

function sortBySite(bookmarks: Bookmark[]): Bookmark[] {
  const sites = new Map(bookmarks.map((bookmark) => [bookmark.id, siteSortKey(bookmark.url)]));
  return bookmarks.sort((a, b) => {
    const siteA = sites.get(a.id) ?? null;
    const siteB = sites.get(b.id) ?? null;
    if (siteA !== siteB) {
      if (siteA === null) { return 1; }
      if (siteB === null) { return -1; }
      return siteA.localeCompare(siteB);
    }
    return a.title.localeCompare(b.title) || compareIds(a, b);
  });
}

/**
 * Returns a sorted copy. Bookmarks saved or edited in one batch share a
 * timestamp, so every order ends with the ID to stay stable across reloads.
 */
export function sortBookmarks(bookmarks: readonly Bookmark[], sortBy: BookmarkSortBy): Bookmark[] {
  const sorted = [...bookmarks];
  switch (sortBy) {
    case "date-newest":
      return sorted.sort(compareBookmarksNewestFirst);
    case "date-oldest":
      return sorted.sort((a, b) => -compareBookmarksNewestFirst(a, b));
    case "updated-newest":
      return sorted.sort((a, b) =>
        bookmarkEditedAt(b.updatedAt, b.createdAt) - bookmarkEditedAt(a.updatedAt, a.createdAt) || compareIds(a, b));
    case "updated-oldest":
      return sorted.sort((a, b) =>
        bookmarkEditedAt(a.updatedAt, a.createdAt) - bookmarkEditedAt(b.updatedAt, b.createdAt) || compareIds(a, b));
    case "alpha-az":
      return sorted.sort((a, b) => a.title.localeCompare(b.title) || compareIds(a, b));
    case "alpha-za":
      return sorted.sort((a, b) => b.title.localeCompare(a.title) || compareIds(a, b));
    case "site-az":
      return sortBySite(sorted);
  }
}
```

In `store/bookmarks-store.ts`, delete the module-private `applySort` function (with its comment), add `sortBookmarks` to the bookmark-utils import, and replace both calls `applySort(applySearch(filtered, state.searchQuery), state.sortBy)` in `getFilteredBookmarks` and `getFavoriteBookmarks` with `sortBookmarks(applySearch(filtered, state.searchQuery), state.sortBy)`.

- [ ] **Step 4: Show short sort labels and sort Favorites**

In `components/dashboard/header.tsx`, replace `sortOptions`:

```ts
const sortOptions = [
  { value: "date-newest", labelKey: "header_sortDateNewest", shortLabelKey: "header_sortShortAddedNewest" },
  { value: "date-oldest", labelKey: "header_sortDateOldest", shortLabelKey: "header_sortShortAddedOldest" },
  { value: "updated-newest", labelKey: "header_sortUpdatedNewest", shortLabelKey: "header_sortShortUpdatedNewest" },
  { value: "updated-oldest", labelKey: "header_sortUpdatedOldest", shortLabelKey: "header_sortShortUpdatedOldest" },
  { value: "alpha-az", labelKey: "header_sortAlphaAZ", shortLabelKey: "header_sortShortAlphaAZ" },
  { value: "alpha-za", labelKey: "header_sortAlphaZA", shortLabelKey: "header_sortShortAlphaZA" },
  { value: "site-az", labelKey: "header_sortSiteAZ", shortLabelKey: "header_sortShortSite" },
] as const;
```

and the trigger label:

```tsx
                <span className="hidden lg:inline">{t(currentSort?.shortLabelKey ?? "header_sortShortAddedNewest")}</span>
```

In `components/dashboard/favorites-content.tsx`, import the sort and subscribe to the order:

```ts
import { sortBookmarks } from "@/lib/bookmark-utils";
```

```ts
  const sortBy = useBookmarksStore(s => s.sortBy);
```

```ts
  const favoriteBookmarks = React.useMemo(
    () => sortBookmarks(
      selectedTags.length === 0
        ? allFavorites
        : allFavorites.filter(b => selectedTags.some(tag => b.tags.includes(tag))),
      sortBy,
    ),
    [allFavorites, selectedTags, sortBy]
  );
```

Add to `public/_locales/en/messages.json`:

```json
  "header_sortUpdatedNewest": {
    "message": "Date Updated (Newest)"
  },
  "header_sortUpdatedOldest": {
    "message": "Date Updated (Oldest)"
  },
  "header_sortSiteAZ": {
    "message": "Website (A-Z)"
  },
  "header_sortShortAddedNewest": {
    "message": "Added ↓"
  },
  "header_sortShortAddedOldest": {
    "message": "Added ↑"
  },
  "header_sortShortUpdatedNewest": {
    "message": "Updated ↓"
  },
  "header_sortShortUpdatedOldest": {
    "message": "Updated ↑"
  },
  "header_sortShortAlphaAZ": {
    "message": "A–Z"
  },
  "header_sortShortAlphaZA": {
    "message": "Z–A"
  },
  "header_sortShortSite": {
    "message": "Site"
  },
```

Add to `public/_locales/zh_CN/messages.json`:

```json
  "header_sortUpdatedNewest": {
    "message": "更新时间（最新优先）"
  },
  "header_sortUpdatedOldest": {
    "message": "更新时间（最早优先）"
  },
  "header_sortSiteAZ": {
    "message": "网站（A-Z）"
  },
  "header_sortShortAddedNewest": {
    "message": "添加 ↓"
  },
  "header_sortShortAddedOldest": {
    "message": "添加 ↑"
  },
  "header_sortShortUpdatedNewest": {
    "message": "更新 ↓"
  },
  "header_sortShortUpdatedOldest": {
    "message": "更新 ↑"
  },
  "header_sortShortAlphaAZ": {
    "message": "A–Z"
  },
  "header_sortShortAlphaZA": {
    "message": "Z–A"
  },
  "header_sortShortSite": {
    "message": "网站"
  },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/bookmark-sort.test.ts test/url-match.test.ts test/view-preferences.test.ts test/bookmarks-header-subscription.test.tsx test/library-visible-filters.test.tsx test/bookmarks-store-sort.test.js && bun run compile`
Expected: all pass; `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add lib/view-preferences.ts lib/url-match.ts lib/bookmark-utils.ts store/bookmarks-store.ts components/dashboard/header.tsx components/dashboard/favorites-content.tsx public/_locales test/bookmark-sort.test.ts test/url-match.test.ts test/view-preferences.test.ts test/bookmarks-header-subscription.test.tsx test/library-visible-filters.test.tsx
git commit -m "feat(bookmarks): sort by date updated and by website

The sort button gets short labels that tell the orders apart, and
the Favorites page now follows the current sort.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Part 3: Selection

### Task 7: Selection store, view orders and selection scope

**Files:**
- Create: `store/selection-store.ts`
- Create: `components/dashboard/shared/selection-orders.tsx`
- Create: `hooks/use-selection-scope.ts`
- Create: `lib/platform.ts`
- Test: `test/selection-store.test.ts`, `test/selection-scope.test.tsx` (new)

**Interfaces:**
- Produces: `useSelectionStore` with `selectedIds: ReadonlySet<string>`, `anchorId: string | null`, `toggle(id)`, `selectRange(orderedIds: readonly string[], toId: string)`, `setMany(ids: readonly string[], selected: boolean)`, `retain(ids: readonly string[])`, `clear()`; `selectionStateOf(selectedIds, ids): "all" | "some" | "none"`; `SelectionOrders { viewOrder: readonly string[]; onScreenOrder: readonly string[] }`, `SelectionOrdersProvider` (props `viewOrder`, `onScreenOrder`, `children`), `useSelectionOrders(): React.RefObject<SelectionOrders> | null`; `useSelectionScope(viewOrder: readonly string[]): void`; `isMacPlatform(): boolean`, `isToggleSelectionClick(event: { metaKey: boolean; ctrlKey: boolean }): boolean`.

- [ ] **Step 1: Write the failing tests**

Create `test/selection-store.test.ts`:

```ts
// @ts-expect-error Bun provides this test module at runtime.
import { beforeEach, describe, expect, test } from "bun:test";
import { importFresh } from "./helpers/module-replacer";

const { useSelectionStore, selectionStateOf } =
  await importFresh<typeof import("@/store/selection-store")>("store/selection-store.ts");

const ORDER = ["a", "b", "c", "d", "e"];
const store = () => useSelectionStore.getState();
const selected = () => [...store().selectedIds].sort();

beforeEach(() => {
  store().clear();
});

describe("selection store", () => {
  test("toggle adds and removes one bookmark and makes it the anchor", () => {
    store().toggle("b");
    expect(selected()).toEqual(["b"]);
    expect(store().anchorId).toBe("b");
    store().toggle("b");
    expect(selected()).toEqual([]);
    expect(store().anchorId).toBe("b");
  });

  test("replaces the set on every change instead of mutating it", () => {
    const before = store().selectedIds;
    store().toggle("a");
    expect(before.has("a")).toBe(false);
    expect(store().selectedIds).not.toBe(before);
  });

  test("selectRange adds everything between the anchor and the target and keeps the anchor", () => {
    store().toggle("b");
    store().selectRange(ORDER, "d");
    expect(selected()).toEqual(["b", "c", "d"]);
    expect(store().anchorId).toBe("b");
    store().selectRange(ORDER, "a");
    expect(selected()).toEqual(["a", "b", "c", "d"]);
  });

  test("selectRange without a usable anchor toggles the target", () => {
    store().selectRange(ORDER, "c");
    expect(selected()).toEqual(["c"]);
    expect(store().anchorId).toBe("c");
    store().selectRange(["x", "y"], "y");
    expect(selected()).toEqual(["c", "y"]);
    expect(store().anchorId).toBe("y");
  });

  test("setMany selects or deselects a group without moving the anchor", () => {
    store().toggle("a");
    store().setMany(["c", "d"], true);
    expect(selected()).toEqual(["a", "c", "d"]);
    store().setMany(["a", "c"], false);
    expect(selected()).toEqual(["d"]);
    expect(store().anchorId).toBe("a");
  });

  test("retain drops bookmarks that left the view and leaves the state alone when none did", () => {
    store().setMany(["a", "b"], true);
    const before = store();
    store().retain(["a", "b", "c"]);
    expect(store()).toBe(before);

    store().toggle("b");
    store().toggle("b");
    store().retain(["a"]);
    expect(selected()).toEqual(["a"]);
    expect(store().anchorId).toBeNull();
  });

  test("clear empties the selection and leaves an empty one alone", () => {
    store().setMany(["a", "b"], true);
    store().clear();
    expect(selected()).toEqual([]);
    expect(store().anchorId).toBeNull();
    const before = store();
    store().clear();
    expect(store()).toBe(before);
  });

  test("selectionStateOf reports all, some or none of a group", () => {
    const ids = new Set(["a", "b"]);
    expect(selectionStateOf(ids, ["a", "b"])).toBe("all");
    expect(selectionStateOf(ids, ["a", "c"])).toBe("some");
    expect(selectionStateOf(ids, ["c"])).toBe("none");
    expect(selectionStateOf(ids, [])).toBe("none");
  });
});
```

Create `test/selection-scope.test.tsx`:

```tsx
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { installAppModules, pressKey, render, setupDom, teardownDom, type AppModules, type RenderResult } from "./helpers/dom-environment";
import { makeWorkspace } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
let app: AppModules;
let useSelectionStore: typeof import("@/store/selection-store").useSelectionStore;
let useSelectionScope: typeof import("@/hooks/use-selection-scope").useSelectionScope;
let view: RenderResult | null = null;

function Host({ viewOrder }: { viewOrder: readonly string[] }) {
  useSelectionScope(viewOrder);
  return null;
}

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ useSelectionStore } = await import("@/store/selection-store"));
  ({ useSelectionScope } = await importFresh<typeof import("@/hooks/use-selection-scope")>("hooks/use-selection-scope.ts"));
});
afterAll(async () => {
  view?.unmount();
  replacer.restore();
  await teardownDom();
});
beforeEach(() => {
  view?.unmount();
  app.useWorkspaceStore.setState({ activeWorkspaceId: "home", workspaces: [makeWorkspace("home"), makeWorkspace("work")] });
  app.useBookmarksStore.setState({ selectedCollection: "all", selectedTags: [], filterType: "all", searchQuery: "" });
  view = render(app, createElement(Host, { viewOrder: ["a", "b", "c"] }));
  act(() => {
    useSelectionStore.getState().setMany(["a", "b"], true);
  });
});

const selected = () => [...useSelectionStore.getState().selectedIds].sort();

describe("useSelectionScope", () => {
  test("keeps only bookmarks that are still in the view", () => {
    view?.rerender(createElement(Host, { viewOrder: ["a", "c"] }));
    expect(selected()).toEqual(["a"]);
  });

  test("clears the selection when the workspace, collection, tags, filter or search change", () => {
    const changes: Array<() => void> = [
      () => app.useWorkspaceStore.setState({ activeWorkspaceId: "work" }),
      () => app.useBookmarksStore.setState({ selectedCollection: "reading" }),
      () => app.useBookmarksStore.setState({ selectedTags: ["frontend"] }),
      () => app.useBookmarksStore.setState({ filterType: "with-tags" }),
      () => app.useBookmarksStore.setState({ searchQuery: "docs" }),
    ];
    for (const change of changes) {
      act(() => {
        useSelectionStore.getState().setMany(["a"], true);
      });
      act(change);
      expect(selected()).toEqual([]);
    }
  });

  test("clears the selection when the view unmounts", () => {
    view?.unmount();
    view = null;
    expect(selected()).toEqual([]);
  });

  test("Esc clears the selection", () => {
    pressKey(document.body, "Escape");
    expect(selected()).toEqual([]);
  });

  test("Esc typed in a field keeps the selection", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    try {
      pressKey(input, "Escape");
      expect(selected()).toEqual(["a", "b"]);
    } finally {
      input.remove();
    }
  });

  test("Esc another component already handled keeps the selection", () => {
    const handleKeyDown = (event: KeyboardEvent) => event.preventDefault();
    document.addEventListener("keydown", handleKeyDown, { capture: true });
    try {
      pressKey(document.body, "Escape");
      expect(selected()).toEqual(["a", "b"]);
    } finally {
      document.removeEventListener("keydown", handleKeyDown, { capture: true });
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/selection-store.test.ts test/selection-scope.test.tsx`
Expected: FAIL — `Cannot find module '@/store/selection-store'` (and `@/hooks/use-selection-scope`).

- [ ] **Step 3: Implement the store, the orders context, the scope hook and the platform rule**

Create `store/selection-store.ts`:

```ts
import { create } from "zustand";

export type GroupSelectionState = "all" | "some" | "none";

interface SelectionState {
  /** Replaced, never mutated, on every change. */
  selectedIds: ReadonlySet<string>;
  /** Where the next Shift+click range starts. */
  anchorId: string | null;
  /** Adds or removes one bookmark and makes it the anchor. */
  toggle: (id: string) => void;
  /**
   * Adds every bookmark from the anchor to `toId` in `orderedIds`, inclusive,
   * and keeps the anchor. Without a usable anchor it toggles `toId`.
   */
  selectRange: (orderedIds: readonly string[], toId: string) => void;
  /** Selects or deselects many bookmarks without moving the anchor. */
  setMany: (ids: readonly string[], selected: boolean) => void;
  /** Keeps only the bookmarks in `ids`, e.g. the ones still in the view. */
  retain: (ids: readonly string[]) => void;
  clear: () => void;
}

const NONE: ReadonlySet<string> = new Set<string>();

function toggled(selectedIds: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selectedIds);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

/** The bookmarks selected in the current view. Never persisted. */
export const useSelectionStore = create<SelectionState>()((set) => ({
  selectedIds: NONE,
  anchorId: null,

  toggle: (id) => set((state) => ({ selectedIds: toggled(state.selectedIds, id), anchorId: id })),

  selectRange: (orderedIds, toId) => set((state) => {
    const from = state.anchorId === null ? -1 : orderedIds.indexOf(state.anchorId);
    const to = orderedIds.indexOf(toId);
    if (from === -1 || to === -1) {
      return { selectedIds: toggled(state.selectedIds, toId), anchorId: toId };
    }
    const next = new Set(state.selectedIds);
    for (let index = Math.min(from, to); index <= Math.max(from, to); index += 1) {
      next.add(orderedIds[index]);
    }
    return { selectedIds: next };
  }),

  setMany: (ids, selected) => set((state) => {
    const next = new Set(state.selectedIds);
    for (const id of ids) {
      if (selected) {
        next.add(id);
      } else {
        next.delete(id);
      }
    }
    return { selectedIds: next };
  }),

  // Runs whenever a view's list changes, so it must not notify when nothing drops out.
  retain: (ids) => set((state) => {
    const keep = new Set(ids);
    const kept = [...state.selectedIds].filter((id) => keep.has(id));
    if (kept.length === state.selectedIds.size) {
      return state;
    }
    return {
      selectedIds: new Set(kept),
      anchorId: state.anchorId !== null && keep.has(state.anchorId) ? state.anchorId : null,
    };
  }),

  clear: () => set((state) => (
    state.selectedIds.size === 0 && state.anchorId === null ? state : { selectedIds: NONE, anchorId: null }
  )),
}));

/** Whether all, some, or none of a group's bookmarks are selected; "none" for an empty group. */
export function selectionStateOf(selectedIds: ReadonlySet<string>, ids: readonly string[]): GroupSelectionState {
  let count = 0;
  for (const id of ids) {
    if (selectedIds.has(id)) {
      count += 1;
    }
  }
  if (count === 0) {
    return "none";
  }
  return count === ids.length ? "all" : "some";
}
```

Create `components/dashboard/shared/selection-orders.tsx`:

```tsx
import * as React from "react";

export interface SelectionOrders {
  /** Every bookmark the view lists, in display order, including those in collapsed groups. */
  viewOrder: readonly string[];
  /** The view order without collapsed groups: what Shift+click and Select all use. */
  onScreenOrder: readonly string[];
}

const SelectionOrdersContext = React.createContext<React.RefObject<SelectionOrders> | null>(null);

interface SelectionOrdersProviderProps extends SelectionOrders {
  children: React.ReactNode;
}

/**
 * Makes a view's bookmarks selectable. The context value is a ref that never
 * changes, so a new list does not re-render every card; cards read the
 * orders in their event handlers.
 */
export function SelectionOrdersProvider({ viewOrder, onScreenOrder, children }: SelectionOrdersProviderProps) {
  const ordersRef = React.useRef<SelectionOrders>({ viewOrder, onScreenOrder });
  React.useLayoutEffect(() => {
    ordersRef.current = { viewOrder, onScreenOrder };
  }, [viewOrder, onScreenOrder]);
  return <SelectionOrdersContext.Provider value={ordersRef}>{children}</SelectionOrdersContext.Provider>;
}

/** The enclosing view's orders, or null outside a selectable view. */
export function useSelectionOrders(): React.RefObject<SelectionOrders> | null {
  return React.useContext(SelectionOrdersContext);
}
```

Create `hooks/use-selection-scope.ts`:

```ts
import * as React from "react";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useSelectionStore } from "@/store/selection-store";
import { useWorkspaceStore } from "@/store/workspace-store";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.isContentEditable || target.closest("input, textarea, select") !== null;
}

/**
 * Ties the selection to the view that shows it. The selection keeps only
 * bookmarks still in `viewOrder`; it clears when the active workspace,
 * selected collection, tags, filter or search change, when the view unmounts
 * (a route change), and on Esc, unless another component handled the key
 * (Radix calls preventDefault when it closes a menu or dialog) or it came
 * from a field.
 */
export function useSelectionScope(viewOrder: readonly string[]): void {
  const retain = useSelectionStore((s) => s.retain);
  const clear = useSelectionStore((s) => s.clear);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const selectedCollection = useBookmarksStore((s) => s.selectedCollection);
  const selectedTags = useBookmarksStore((s) => s.selectedTags);
  const filterType = useBookmarksStore((s) => s.filterType);
  const searchQuery = useBookmarksStore((s) => s.searchQuery);

  React.useEffect(() => {
    clear();
  }, [activeWorkspaceId, selectedCollection, selectedTags, filterType, searchQuery, clear]);

  React.useEffect(() => () => clear(), [clear]);

  React.useEffect(() => {
    retain(viewOrder);
  }, [viewOrder, retain]);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isEditableTarget(event.target)) {
        return;
      }
      clear();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [clear]);
}
```

Create `lib/platform.ts`:

```ts
/** macOS and iPadOS use Cmd where Windows and Linux use Ctrl. */
export function isMacPlatform(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(globalThis.navigator?.platform ?? "");
}

/** Cmd+click on macOS and Ctrl+click elsewhere toggle one item of a multi-selection. */
export function isToggleSelectionClick(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMacPlatform() ? event.metaKey : event.ctrlKey;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/selection-store.test.ts test/selection-scope.test.tsx && bun run compile`
Expected: all pass; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add store/selection-store.ts components/dashboard/shared/selection-orders.tsx hooks/use-selection-scope.ts lib/platform.ts test/selection-store.test.ts test/selection-scope.test.tsx
git commit -m "feat(bookmarks): selection store and view scope

The selection is ephemeral, follows the view's order for ranges,
drops bookmarks that leave the view, and clears on Esc and when the
view's scope changes.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: Select cards and collection groups

**Files:**
- Modify: `components/dashboard/bookmark-card.tsx`
- Modify: `components/dashboard/content.tsx`
- Modify: `components/dashboard/favorites-content.tsx`
- Modify: `test/helpers/dom-environment.ts` (`click` accepts modifier keys)
- Create: `test/helpers/virtualizer.ts`; modify `test/library-visible-filters.test.tsx` to use it
- Modify: both `messages.json`
- Test: `test/bookmark-selection.test.tsx`, `test/library-selection.test.tsx` (new)

**Interfaces:**
- Consumes: Task 7's store, provider, hook and `isToggleSelectionClick`.
- Produces: cards inside a `SelectionOrdersProvider` render a `role="checkbox"` button labeled `bookmarkCard_select[title]` over the favicon square and carry `data-selected` when selected; `BookmarksContent` and `FavoritesContent` provide their orders and call `useSelectionScope`; each grouped collection header renders a three-state `role="checkbox"` labeled `bookmarksContent_selectCollection[name]`; `installMeasuredVirtualizer(replacer, scrollOffsets?)` and `installQuietTabsStore(replacer)` in `test/helpers/virtualizer.ts`; `click(element, init?: MouseEventInit)`.

- [ ] **Step 1: Add the test helpers**

In `test/helpers/dom-environment.ts`, replace `click`:

```ts
export function click(element: Element, init: MouseEventInit = {}): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }));
  });
}
```

Create `test/helpers/virtualizer.ts`:

```ts
import { importFresh, type ModuleReplacer } from "./module-replacer";

/**
 * happy-dom has no layout, so @tanstack/react-virtual would render no rows.
 * This makes every scroll element measure 1200×2000 and records scroll requests.
 */
export async function installMeasuredVirtualizer(replacer: ModuleReplacer, scrollOffsets: number[] = []): Promise<void> {
  const virtual = await import("@tanstack/react-virtual");
  const useRealVirtualizer = virtual.useVirtualizer;
  await replacer.replace("@tanstack/react-virtual", {
    ...virtual,
    useVirtualizer: (options: Parameters<typeof virtual.useVirtualizer>[0]) => useRealVirtualizer({
      ...options,
      initialRect: { width: 1200, height: 2000 },
      observeElementRect: (_instance, callback) => {
        callback({ width: 1200, height: 2000 });
        return () => {};
      },
      scrollToFn: (offset) => {
        scrollOffsets.push(offset);
      },
    }),
  });
}

/** BookmarksContent loads open tabs when it mounts; tests have no tabs API. */
export async function installQuietTabsStore(replacer: ModuleReplacer): Promise<void> {
  const tabs = await importFresh<typeof import("@/store/tabs-store")>("store/tabs-store.ts");
  tabs.useTabsStore.setState({ loadTabs: async () => {} });
  await replacer.replace("@/store/tabs-store", tabs);
}
```

In `test/library-visible-filters.test.tsx`, import the helpers and replace the inline virtualizer and tabs-store setup in `beforeAll`:

```ts
import { installMeasuredVirtualizer, installQuietTabsStore } from "./helpers/virtualizer";
```

```ts
beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  await installMeasuredVirtualizer(replacer, scrollOffsets);
  await installQuietTabsStore(replacer);
  ({ FavoritesContent } = await importFresh<typeof import("@/components/dashboard/favorites-content")>("components/dashboard/favorites-content.tsx"));
  ({ BookmarksContent } = await importFresh<typeof import("@/components/dashboard/content")>("components/dashboard/content.tsx"));
  ({ revealBookmark } = await importFresh<typeof import("@/lib/reveal-bookmark")>("lib/reveal-bookmark.ts"));
});
```

Run: `bun test test/library-visible-filters.test.tsx`
Expected: all tests still pass.

- [ ] **Step 2: Write the failing tests**

Create `test/bookmark-selection.test.tsx`:

```tsx
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { click, getBySelector, installAppModules, pressKey, render, setupDom, teardownDom, type AppModules, type RenderResult } from "./helpers/dom-environment";
import { bookmarkMap, countsByCollection, makeBookmark, makeCollection, makeTag, makeWorkspace } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
const smartOpenUrl = mock(async () => {});
let app: AppModules;
let FavoritesContent: typeof import("@/components/dashboard/favorites-content").FavoritesContent;
let BookmarkCard: typeof import("@/components/dashboard/bookmark-card").BookmarkCard;
let useSelectionStore: typeof import("@/store/selection-store").useSelectionStore;
let isMacPlatform: typeof import("@/lib/platform").isMacPlatform;
let view: RenderResult | null = null;

const favorites = ["a", "b", "c", "d"].map((id) => makeBookmark(id, {
  title: id.toUpperCase(),
  collectionId: "reading",
  isFavorite: true,
  tags: id === "a" ? ["frontend"] : [],
}));

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  const realTabs = await importFresh<typeof import("@/lib/chrome/tabs")>("lib/chrome/tabs.ts");
  await replacer.replace("@/lib/chrome/tabs", { ...realTabs, smartOpenUrl });
  ({ useSelectionStore } = await import("@/store/selection-store"));
  ({ isMacPlatform } = await import("@/lib/platform"));
  ({ BookmarkCard } = await importFresh<typeof import("@/components/dashboard/bookmark-card")>("components/dashboard/bookmark-card.tsx"));
  ({ FavoritesContent } = await importFresh<typeof import("@/components/dashboard/favorites-content")>("components/dashboard/favorites-content.tsx"));
});
afterAll(async () => {
  view?.unmount();
  replacer.restore();
  await teardownDom();
});
beforeEach(() => {
  view?.unmount();
  smartOpenUrl.mockClear();
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home")],
    collections: [makeCollection("reading", "home", { isDefault: true })],
    tags: [makeTag("frontend", "Frontend")],
  });
  app.useBookmarksStore.setState({
    bookmarks: bookmarkMap(favorites),
    countsByCollection: countsByCollection(favorites),
    selectedCollection: "all",
    selectedTags: [],
    filterType: "all",
    searchQuery: "",
    sortBy: "alpha-az",
    viewMode: "list",
  });
  act(() => {
    useSelectionStore.getState().clear();
  });
  view = render(app, createElement(MemoryRouter, null, createElement(FavoritesContent)));
});

const card = (id: string) => getBySelector(`[data-bookmark-id="${id}"]`);
const checkbox = (id: string) => getBySelector(`[data-bookmark-id="${id}"] [role="checkbox"]`);
const selected = () => [...useSelectionStore.getState().selectedIds].sort();
const toggleModifier = (): MouseEventInit => (isMacPlatform() ? { metaKey: true } : { ctrlKey: true });

describe("selecting bookmark cards", () => {
  test("each card offers a labeled checkbox, and checking it does not open the bookmark", () => {
    expect(checkbox("a").getAttribute("aria-label")).toBe("bookmarkCard_select[A]");
    expect(checkbox("a").getAttribute("aria-checked")).toBe("false");

    click(checkbox("a"));

    expect(selected()).toEqual(["a"]);
    expect(checkbox("a").getAttribute("aria-checked")).toBe("true");
    expect(card("a").hasAttribute("data-selected")).toBe(true);
    expect(smartOpenUrl).not.toHaveBeenCalled();
  });

  test("while a selection is active, clicking a card toggles it instead of opening it", () => {
    click(checkbox("a"));
    click(card("b"));
    expect(selected()).toEqual(["a", "b"]);
    click(card("a"));
    expect(selected()).toEqual(["b"]);
    expect(smartOpenUrl).not.toHaveBeenCalled();

    click(card("b"));
    expect(selected()).toEqual([]);
    click(card("c"));
    expect(smartOpenUrl).toHaveBeenCalledWith(favorites[2].url);
  });

  test("Shift+click selects the range from the anchor and keeps the anchor", () => {
    click(checkbox("b"));
    click(card("d"), { shiftKey: true });
    expect(selected()).toEqual(["b", "c", "d"]);
    click(card("a"), { shiftKey: true });
    expect(selected()).toEqual(["a", "b", "c", "d"]);
    expect(smartOpenUrl).not.toHaveBeenCalled();
  });

  test("Shift+click without an anchor toggles the card", () => {
    click(card("c"), { shiftKey: true });
    expect(selected()).toEqual(["c"]);
  });

  test("Cmd or Ctrl+click toggles a card and starts a selection", () => {
    click(card("c"), toggleModifier());
    expect(selected()).toEqual(["c"]);
    expect(smartOpenUrl).not.toHaveBeenCalled();
  });

  test("Shift+press does not start a text selection", () => {
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true, shiftKey: true });
    act(() => {
      card("b").dispatchEvent(press);
    });
    expect(press.defaultPrevented).toBe(true);
  });

  test("clicking a tag on a card filters by it and clears the selection", () => {
    click(checkbox("b"));
    click(getBySelector('[data-bookmark-id="a"] button[data-tag-id="frontend"]'));
    expect(app.useBookmarksStore.getState().selectedTags).toEqual(["frontend"]);
    expect(selected()).toEqual([]);
  });

  test("Esc clears the selection", () => {
    click(checkbox("b"));
    click(checkbox("c"));
    pressKey(document.body, "Escape");
    expect(selected()).toEqual([]);
  });

  test("a bookmark that leaves the view drops out of the selection", () => {
    click(checkbox("a"));
    click(checkbox("b"));
    act(() => {
      app.useBookmarksStore.getState().toggleFavorite("a");
    });
    expect(selected()).toEqual(["b"]);
  });

  test("a card outside a selectable view has no checkbox and still opens on click", () => {
    view?.unmount();
    view = render(app, createElement(BookmarkCard, { bookmark: favorites[0] }));
    expect(document.querySelector('[role="checkbox"]')).toBeNull();
    click(card("a"));
    expect(smartOpenUrl).toHaveBeenCalledWith(favorites[0].url);
  });
});
```

Create `test/library-selection.test.tsx`:

```tsx
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { click, getBySelector, getByText, installAppModules, render, setupDom, teardownDom, type AppModules, type RenderResult } from "./helpers/dom-environment";
import { installMeasuredVirtualizer, installQuietTabsStore } from "./helpers/virtualizer";
import { bookmarkMap, countsByCollection, makeBookmark, makeCollection, makeWorkspace } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
let app: AppModules;
let BookmarksContent: typeof import("@/components/dashboard/content").BookmarksContent;
let useSelectionStore: typeof import("@/store/selection-store").useSelectionStore;
let view: RenderResult | null = null;

const bookmarks = [
  makeBookmark("r1", { title: "R1", collectionId: "reading" }),
  makeBookmark("r2", { title: "R2", collectionId: "reading" }),
  makeBookmark("p1", { title: "P1", collectionId: "projects" }),
  makeBookmark("p2", { title: "P2", collectionId: "projects" }),
  makeBookmark("u1", { title: "U1", collectionId: "" }),
];

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  await installMeasuredVirtualizer(replacer);
  await installQuietTabsStore(replacer);
  ({ useSelectionStore } = await import("@/store/selection-store"));
  ({ BookmarksContent } = await importFresh<typeof import("@/components/dashboard/content")>("components/dashboard/content.tsx"));
});
afterAll(async () => {
  view?.unmount();
  replacer.restore();
  await teardownDom();
});
beforeEach(() => {
  view?.unmount();
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home")],
    collections: [
      makeCollection("reading", "home", { isDefault: true, position: 0 }),
      makeCollection("projects", "home", { position: 1 }),
    ],
    tags: [],
  });
  app.useBookmarksStore.setState({
    bookmarks: bookmarkMap(bookmarks),
    countsByCollection: countsByCollection(bookmarks),
    selectedCollection: "all",
    selectedTags: [],
    filterType: "all",
    searchQuery: "",
    sortBy: "alpha-az",
    viewMode: "list",
    highlightedBookmarkId: null,
  });
  act(() => {
    useSelectionStore.getState().clear();
  });
  view = render(app, createElement(MemoryRouter, null, createElement(BookmarksContent)));
});

const headerCheckbox = (name: string) => getBySelector(`[aria-label="bookmarksContent_selectCollection[${name}]"]`);
const selected = () => [...useSelectionStore.getState().selectedIds].sort();

describe("selecting collection groups", () => {
  test("a header checkbox selects its whole group, even collapsed, and clears it again", () => {
    expect(document.querySelector('[data-bookmark-id="p1"]')).toBeNull();

    click(headerCheckbox("projects"));

    expect(selected()).toEqual(["p1", "p2"]);
    expect(headerCheckbox("projects").getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector('[data-bookmark-id="p1"]')).toBeNull();

    click(headerCheckbox("projects"));
    expect(selected()).toEqual([]);
  });

  test("a header shows a mixed checkbox when part of its group is selected", () => {
    click(getBySelector('[data-bookmark-id="r1"] [role="checkbox"]'));
    expect(headerCheckbox("reading").getAttribute("aria-checked")).toBe("mixed");
    expect(headerCheckbox("projects").getAttribute("aria-checked")).toBe("false");
  });

  test("Shift+click ranges skip the bookmarks of collapsed groups", () => {
    click(getByText("bookmarksContent_uncategorized"));
    click(getBySelector('[data-bookmark-id="r1"] [role="checkbox"]'));
    click(getBySelector('[data-bookmark-id="u1"]'), { shiftKey: true });
    expect(selected()).toEqual(["r1", "r2", "u1"]);
  });

  test("choosing another collection clears the selection", () => {
    click(headerCheckbox("projects"));
    act(() => {
      app.useBookmarksStore.getState().setSelectedCollection("projects");
    });
    expect(selected()).toEqual([]);
  });

  test("leaving the page clears the selection", () => {
    click(headerCheckbox("projects"));
    view?.unmount();
    view = null;
    expect(selected()).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test test/bookmark-selection.test.tsx test/library-selection.test.tsx`
Expected: FAIL — `No element matches [data-bookmark-id="a"] [role="checkbox"]` and `No element matches [aria-label="bookmarksContent_selectCollection[projects]"]`.

- [ ] **Step 4: Make cards selectable**

In `components/dashboard/bookmark-card.tsx`, add the imports:

```ts
import { useSelectionStore } from "@/store/selection-store";
import { isToggleSelectionClick } from "@/lib/platform";
import { useSelectionOrders } from "@/components/dashboard/shared/selection-orders";
```

Add the checkbox component above `BookmarkCard`:

```tsx
interface SelectionCheckboxProps {
  title: string;
  checked: boolean;
  /** Shown without hovering, e.g. while any card is selected. */
  visible: boolean;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

/** Covers the favicon square, so showing it never shifts the card's layout. */
function SelectionCheckbox({ title, checked, visible, onClick }: SelectionCheckboxProps) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={t("bookmarkCard_select", [title])}
      onClick={onClick}
      className={cn(
        "absolute inset-0 flex items-center justify-center bg-muted transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        visible ? "opacity-100" : "opacity-0 group-hover:opacity-100",
      )}
    >
      <span
        className={cn(
          "flex size-4 items-center justify-center rounded-sm border",
          checked ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/60 bg-background",
        )}
      >
        {checked && <Check className="size-3" />}
      </span>
    </button>
  );
}
```

In `BookmarkCard`, add after the `toggleTag` selector:

```ts
  const selectionOrders = useSelectionOrders();
  const selectable = selectionOrders !== null;
  const isSelected = useSelectionStore((s) => selectable && s.selectedIds.has(bookmark.id));
  const selectionActive = useSelectionStore((s) => selectable && s.selectedIds.size > 0);
  const toggleSelection = useSelectionStore((s) => s.toggle);
  const selectRange = useSelectionStore((s) => s.selectRange);
```

and after `handleDelete`:

```ts
  const handleCardClick = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (selectionOrders) {
      if (event.shiftKey) {
        selectRange(selectionOrders.current.onScreenOrder, bookmark.id);
        return;
      }
      if (isToggleSelectionClick(event) || selectionActive) {
        toggleSelection(bookmark.id);
        return;
      }
    }
    void handleSmartOpen();
  }, [selectionOrders, selectionActive, selectRange, toggleSelection, bookmark.id, handleSmartOpen]);

  const handleCheckboxClick = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (selectionOrders && event.shiftKey) {
      selectRange(selectionOrders.current.onScreenOrder, bookmark.id);
      return;
    }
    toggleSelection(bookmark.id);
  }, [selectionOrders, selectRange, toggleSelection, bookmark.id]);

  // Shift+click selects a range of cards, not the page text between them.
  const handleCardMouseDown = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (selectable && event.shiftKey) {
      event.preventDefault();
    }
  }, [selectable]);
```

In both variants, on the root `div`: add `data-selected={isSelected || undefined}`, replace `onClick={handleSmartOpen}` with `onClick={handleCardClick}`, add `onMouseDown={handleCardMouseDown}`, and add the selected style as the last `cn()` argument:

```tsx
            isSelected && "border-primary/40 bg-primary/5 ring-2 ring-primary/60",
```

Give each favicon square `relative` and render the checkbox inside it. List variant:

```tsx
            <div className="relative size-10 rounded-lg bg-muted flex items-center justify-center overflow-hidden shrink-0">
              <FaviconImage
                src={bookmark.favicon}
                alt={bookmark.title}
                className="size-6"
                hasDarkIcon={bookmark.hasDarkIcon}
              />
              {selectable && (
                <SelectionCheckbox title={bookmark.title} checked={isSelected} visible={selectionActive} onClick={handleCheckboxClick} />
              )}
            </div>
```

Grid variant:

```tsx
            <div className="relative size-7 rounded-md bg-muted shrink-0 flex items-center justify-center overflow-hidden">
              <FaviconImage
                src={bookmark.favicon}
                alt={bookmark.title}
                className="size-4"
                hasDarkIcon={bookmark.hasDarkIcon}
              />
              {selectable && (
                <SelectionCheckbox title={bookmark.title} checked={isSelected} visible={selectionActive} onClick={handleCheckboxClick} />
              )}
            </div>
```

Leave the list variant's open button (`onClick={handleSmartOpen}` inside the actions group) as it is.

- [ ] **Step 5: Provide orders in Favorites**

In `components/dashboard/favorites-content.tsx`, import:

```ts
import { SelectionOrdersProvider } from "@/components/dashboard/shared/selection-orders";
import { useSelectionScope } from "@/hooks/use-selection-scope";
```

After `favoriteBookmarks`, add:

```ts
  const viewOrder = React.useMemo(() => favoriteBookmarks.map((bookmark) => bookmark.id), [favoriteBookmarks]);
  useSelectionScope(viewOrder);
```

and wrap the returned tree:

```tsx
  return (
    <SelectionOrdersProvider viewOrder={viewOrder} onScreenOrder={viewOrder}>
      <div className="flex-1 w-full overflow-auto">
        {/* existing content unchanged */}
      </div>
    </SelectionOrdersProvider>
  );
```

- [ ] **Step 6: Group selection in the library**

In `components/dashboard/content.tsx`, add `Check` and `Minus` to the existing `lucide-react` import list, and add:

```ts
import { selectionStateOf, useSelectionStore } from "@/store/selection-store";
import { SelectionOrdersProvider } from "@/components/dashboard/shared/selection-orders";
import { useSelectionScope } from "@/hooks/use-selection-scope";
```

Replace `DroppableCollectionHeaderProps` and add the row type and the header checkbox:

```tsx
interface CollectionHeaderRow {
  collectionId: string;
  collectionName: string;
  count: number;
  icon: string;
  isDefault: boolean;
  /** The group's bookmarks in view order, including a collapsed group's. */
  bookmarkIds: readonly string[];
}

interface DroppableCollectionHeaderProps {
  rowData: CollectionHeaderRow;
  isExpanded: boolean;
  onToggle: () => void;
}

interface CollectionSelectionCheckboxProps {
  name: string;
  bookmarkIds: readonly string[];
}

/** Checked when the whole group is selected, mixed when part of it is; clicking selects or clears the group. */
function CollectionSelectionCheckbox({ name, bookmarkIds }: CollectionSelectionCheckboxProps) {
  const { t } = useTranslation();
  const state = useSelectionStore((s) => selectionStateOf(s.selectedIds, bookmarkIds));
  const selectionActive = useSelectionStore((s) => s.selectedIds.size > 0);
  const setMany = useSelectionStore((s) => s.setMany);
  if (bookmarkIds.length === 0) {
    return null;
  }
  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setMany(bookmarkIds, state !== "all");
  };
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "all" ? true : state === "some" ? "mixed" : false}
      aria-label={t("bookmarksContent_selectCollection", [name])}
      onClick={handleClick}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-sm border transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        state === "none" ? "border-muted-foreground/60 bg-background" : "border-primary bg-primary text-primary-foreground",
        selectionActive || state !== "none" ? "opacity-100" : "opacity-0 group-hover:opacity-100",
      )}
    >
      {state === "all" && <Check className="size-3" />}
      {state === "some" && <Minus className="size-3" />}
    </button>
  );
}
```

In `DroppableCollectionHeader`, render the checkbox first in the left cluster:

```tsx
      <div className="flex items-center gap-3">
        <CollectionSelectionCheckbox name={rowData.collectionName} bookmarkIds={rowData.bookmarkIds} />
        <ChevronDown
```

Replace the `VirtualItem` type:

```ts
type VirtualItem =
  | { type: "hero_and_title" }
  | ({ type: "collection_header" } & CollectionHeaderRow)
  | { type: "bookmarks_row"; collectionId: string; bookmarks: BookmarkType[]; rowIndex: number }
  | { type: "collection_dropzone"; collectionId: string }
  | { type: "empty_state"; title: string; description: string };

interface BookmarkGroup {
  collectionId: string;
  collectionName: string;
  icon: string;
  isDefault: boolean;
  bookmarks: BookmarkType[];
}
```

In `BookmarksContent`, replace the whole `virtualRows` memo with the groups, the orders and the rows:

```tsx
  /** "All bookmarks" groups: active collections in sidebar order, then uncategorized when it has bookmarks. */
  const groups = React.useMemo<BookmarkGroup[] | null>(() => {
    if (selectedCollection !== "all") {
      return null;
    }
    const byCollection = new Map<string, BookmarkType[]>(activeCollections.map((collection) => [collection.id, []]));
    const uncategorized: BookmarkType[] = [];
    for (const bookmark of filteredBookmarks) {
      const group = byCollection.get(bookmark.collectionId);
      if (group) {
        group.push(bookmark);
      } else {
        uncategorized.push(bookmark);
      }
    }
    const result: BookmarkGroup[] = activeCollections.map((collection) => ({
      collectionId: collection.id,
      collectionName: collection.name,
      icon: collection.icon,
      isDefault: collection.isDefault ?? false,
      bookmarks: byCollection.get(collection.id) ?? [],
    }));
    if (uncategorized.length > 0) {
      result.push({
        collectionId: "uncategorized",
        collectionName: t("bookmarksContent_uncategorized"),
        icon: "bookmark",
        isDefault: false,
        bookmarks: uncategorized,
      });
    }
    return result;
  }, [selectedCollection, filteredBookmarks, activeCollections, t]);

  const isGroupExpanded = React.useCallback(
    (group: BookmarkGroup) => expandedCollectionIds[group.collectionId] ?? group.isDefault,
    [expandedCollectionIds],
  );

  const viewOrder = React.useMemo(
    () => groups
      ? groups.flatMap((group) => group.bookmarks.map((bookmark) => bookmark.id))
      : filteredBookmarks.map((bookmark) => bookmark.id),
    [groups, filteredBookmarks],
  );
  const onScreenOrder = React.useMemo(
    () => groups
      ? groups.filter(isGroupExpanded).flatMap((group) => group.bookmarks.map((bookmark) => bookmark.id))
      : viewOrder,
    [groups, isGroupExpanded, viewOrder],
  );
  useSelectionScope(viewOrder);

  const virtualRows = React.useMemo<VirtualItem[]>(() => {
    const rows: VirtualItem[] = [{ type: "hero_and_title" }];
    if (filteredBookmarks.length === 0) {
      rows.push({
        type: "empty_state",
        title: t("bookmarksContent_emptyTitle"),
        description: t("bookmarksContent_emptyDesc"),
      });
      return rows;
    }
    const columns = viewMode === "grid" ? gridCols : 1;
    const pushBookmarkRows = (collectionId: string, bookmarks: BookmarkType[]) => {
      for (let rowIndex = 0; rowIndex * columns < bookmarks.length; rowIndex += 1) {
        rows.push({
          type: "bookmarks_row",
          collectionId,
          bookmarks: bookmarks.slice(rowIndex * columns, (rowIndex + 1) * columns),
          rowIndex,
        });
      }
    };
    if (!groups) {
      pushBookmarkRows(selectedCollection, filteredBookmarks);
      return rows;
    }
    for (const group of groups) {
      rows.push({
        type: "collection_header",
        collectionId: group.collectionId,
        collectionName: group.collectionName,
        count: group.bookmarks.length,
        icon: group.icon,
        isDefault: group.isDefault,
        bookmarkIds: group.bookmarks.map((bookmark) => bookmark.id),
      });
      if (!isGroupExpanded(group)) {
        continue;
      }
      if (group.bookmarks.length > 0) {
        pushBookmarkRows(group.collectionId, group.bookmarks);
      } else {
        rows.push({ type: "collection_dropzone", collectionId: group.collectionId });
      }
    }
    return rows;
  }, [filteredBookmarks, groups, isGroupExpanded, selectedCollection, viewMode, gridCols, t]);
```

Wrap the returned tree in the provider:

```tsx
  return (
    <SelectionOrdersProvider viewOrder={viewOrder} onScreenOrder={onScreenOrder}>
      <div ref={parentRef} className="flex-1 w-full overflow-auto relative">
        {/* existing content unchanged */}
      </div>
    </SelectionOrdersProvider>
  );
```

Add to `public/_locales/en/messages.json`:

```json
  "bookmarkCard_select": {
    "message": "Select $1",
    "placeholders": {
      "1": {
        "content": "$1"
      }
    }
  },
  "bookmarksContent_selectCollection": {
    "message": "Select all bookmarks in $1",
    "placeholders": {
      "1": {
        "content": "$1"
      }
    }
  },
```

Add to `public/_locales/zh_CN/messages.json`:

```json
  "bookmarkCard_select": {
    "message": "选择 $1",
    "placeholders": {
      "1": {
        "content": "$1"
      }
    }
  },
  "bookmarksContent_selectCollection": {
    "message": "选择 $1 中的全部书签",
    "placeholders": {
      "1": {
        "content": "$1"
      }
    }
  },
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test test/bookmark-selection.test.tsx test/library-selection.test.tsx test/library-visible-filters.test.tsx test/bookmark-card-menu.test.tsx test/highlight-deep-link.test.tsx test/workspace-collection-reset.test.tsx && bun run compile`
Expected: all pass; `tsc` exits 0.

- [ ] **Step 8: Commit**

```bash
git add components/dashboard/bookmark-card.tsx components/dashboard/content.tsx components/dashboard/favorites-content.tsx test/helpers/dom-environment.ts test/helpers/virtualizer.ts test/library-visible-filters.test.tsx test/bookmark-selection.test.tsx test/library-selection.test.tsx public/_locales
git commit -m "feat(bookmarks): select cards and collection groups

Cards in the library and on Favorites get a hover checkbox,
Shift+click ranges and Cmd/Ctrl+click toggles; while anything is
selected a click selects instead of opening. Collection headers
select or clear their whole group, including collapsed ones.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: Popover, filterable list, collection picker and tag picker

**Files:**
- Create: `components/ui/popover.tsx`
- Create: `lib/tag-name.ts`
- Modify: `components/dashboard/sidebar/tag-dialog.tsx` (`handleSubmit`)
- Create: `components/dashboard/shared/filterable-list.tsx`
- Create: `components/dashboard/shared/collection-picker.tsx`
- Create: `components/dashboard/shared/tag-picker.tsx`
- Modify: `test/helpers/dom-environment.ts` (`pressKey` accepts modifier keys)
- Modify: both `messages.json`
- Test: `test/tag-name.test.ts`, `test/filterable-list.test.tsx`, `test/collection-picker.test.tsx`, `test/tag-picker.test.tsx` (new); `test/tag-dialog.test.tsx` (regression)

**Interfaces:**
- Produces: `Popover`, `PopoverTrigger`, `PopoverContent`, `PopoverAnchor`; `tagNameError(name: string, takenNames: readonly string[]): "empty" | "duplicate" | null`; `FilterableList<T extends FilterableListItem>` with props `items`, `query`, `onQueryChange`, `onActivate(item)`, optional `create: { canCreate(name): boolean; onCreate(name): void }`, `renderItem`, `itemAria`, `placeholder`, `emptyText`, `listHidden`, `inputId`, `autoFocus`, `onInputKeyDown`, `onInputFocus`, `onInputBlur`, `className`, `listClassName`; `CollectionPicker` with props `selectedId: string | null`, `onSelect(collectionId)`, `children: React.ReactElement` (the trigger), `align?`; `TagPicker` with props `value: readonly string[]`, `onChange(tagIds: string[])`, `inputId?`, `autoFocus?`; `pressKey(element, key, init?: KeyboardEventInit)`.

- [ ] **Step 1: Write the failing tests**

In `test/helpers/dom-environment.ts`, replace `pressKey`:

```ts
export function pressKey(element: Element, key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...init }));
  });
}
```

Create `test/tag-name.test.ts`:

```ts
// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import { tagNameError } from "@/lib/tag-name";

describe("tagNameError", () => {
  test("requires a name", () => {
    expect(tagNameError("   ", ["Read"])).toBe("empty");
  });
  test("rejects another tag's name, ignoring case and surrounding spaces", () => {
    expect(tagNameError("  read ", ["Read"])).toBe("duplicate");
  });
  test("accepts a new name", () => {
    expect(tagNameError("Reading", ["Read"])).toBeNull();
  });
});
```

Create `test/filterable-list.test.tsx`:

```tsx
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement, useState } from "react";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { click, getBySelector, getByText, installAppModules, pressKey, queryByText, render, setupDom, teardownDom, typeInto, type AppModules, type RenderResult } from "./helpers/dom-environment";

const replacer = createModuleReplacer();
const handleActivate = mock((_item: { id: string; label: string }) => {});
const handleCreate = mock((_name: string) => {});
let app: AppModules;
let FilterableList: typeof import("@/components/dashboard/shared/filterable-list").FilterableList;
let view: RenderResult | null = null;
let creatable = true;

const ITEMS = [
  { id: "alpha", label: "Alpha" },
  { id: "beta", label: "Beta" },
  { id: "alphabet", label: "Alphabet" },
];

function Host() {
  const [query, setQuery] = useState("");
  return createElement(FilterableList<{ id: string; label: string }>, {
    items: ITEMS,
    query,
    onQueryChange: setQuery,
    onActivate: handleActivate,
    create: { canCreate: () => creatable, onCreate: handleCreate },
    placeholder: "filter",
    emptyText: "nothing",
  });
}

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ FilterableList } = await importFresh<typeof import("@/components/dashboard/shared/filterable-list")>("components/dashboard/shared/filterable-list.tsx"));
});
afterAll(async () => {
  view?.unmount();
  replacer.restore();
  await teardownDom();
});
beforeEach(() => {
  view?.unmount();
  handleActivate.mockClear();
  handleCreate.mockClear();
  creatable = true;
  view = render(app, createElement(Host));
});

const input = () => getBySelector<HTMLInputElement>('[role="combobox"]');
const options = () => Array.from(document.querySelectorAll('[role="option"]')).map((option) => option.textContent?.trim());

describe("FilterableList", () => {
  test("filters items by the typed text, ignoring case", () => {
    typeInto(input(), "ALPH");
    expect(options()).toEqual(["Alpha", "Alphabet", "filterableList_create[ALPH]"]);
  });

  test("arrow keys move the highlight and Enter activates the highlighted item", () => {
    typeInto(input(), "alph");
    pressKey(input(), "ArrowDown");
    expect(getBySelector('[role="option"][aria-selected="true"]').textContent).toBe("Alphabet");
    pressKey(input(), "Enter");
    expect(handleActivate).toHaveBeenCalledWith(ITEMS[2]);
  });

  test("Enter with an empty query activates nothing until the user picks a row", () => {
    pressKey(input(), "Enter");
    expect(handleActivate).not.toHaveBeenCalled();
    pressKey(input(), "ArrowDown");
    pressKey(input(), "Enter");
    expect(handleActivate).toHaveBeenCalledWith(ITEMS[1]);
  });

  test("offers to create a name no item has, and creates it with the trimmed name", () => {
    typeInto(input(), "  Gamma ");
    pressKey(input(), "Enter");
    expect(handleCreate).toHaveBeenCalledWith("Gamma");
  });

  test("does not offer to create a name that exists or that the owner refuses", () => {
    typeInto(input(), "beta");
    expect(queryByText("filterableList_create[beta]")).toBeNull();
    creatable = false;
    typeInto(input(), "Gamma");
    expect(queryByText("filterableList_create[Gamma]")).toBeNull();
    expect(getByText("nothing")).toBeTruthy();
  });

  test("leaves Cmd or Ctrl+Enter to the surrounding form", () => {
    typeInto(input(), "alpha");
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", ctrlKey: true });
    input().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(handleActivate).not.toHaveBeenCalled();
  });

  test("clicking an option activates it", () => {
    click(getByText("Beta"));
    expect(handleActivate).toHaveBeenCalledWith(ITEMS[1]);
  });
});
```

Create `test/collection-picker.test.tsx`:

```tsx
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { click, getBySelector, getByText, installAppModules, render, setupDom, submitForm, teardownDom, typeInto, type AppModules, type RenderResult } from "./helpers/dom-environment";
import { makeCollection, makeWorkspace } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
const handleSelect = mock((_collectionId: string) => {});
let app: AppModules;
let CollectionPicker: typeof import("@/components/dashboard/shared/collection-picker").CollectionPicker;
let view: RenderResult | null = null;

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ CollectionPicker } = await importFresh<typeof import("@/components/dashboard/shared/collection-picker")>("components/dashboard/shared/collection-picker.tsx"));
});
afterAll(async () => {
  view?.unmount();
  replacer.restore();
  await teardownDom();
});
beforeEach(() => {
  view?.unmount();
  handleSelect.mockClear();
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home"), makeWorkspace("work")],
    collections: [
      makeCollection("older", "home", { name: "Older", position: 1 }),
      makeCollection("newer", "home", { name: "Newer", position: 5 }),
      makeCollection("inbox", "home", { name: "Inbox", isDefault: true, position: 0 }),
      makeCollection("archived", "home", { name: "Archived", position: 9, archivedAt: 1 }),
      makeCollection("elsewhere", "work", { name: "Elsewhere", position: 3 }),
    ],
  });
  view = render(app, createElement(CollectionPicker, {
    selectedId: "older",
    onSelect: handleSelect,
    children: createElement("button", { type: "button" }, "pick"),
  }));
  click(getByText("pick"));
});

const options = () => Array.from(document.querySelectorAll('[role="option"]')).map((option) => option.textContent?.trim());

describe("CollectionPicker", () => {
  test("lists the workspace's active collections, default first, then newest", () => {
    expect(options()).toEqual(["Inbox", "Newer", "Older"]);
  });

  test("typing filters the list and choosing a collection selects it and closes the picker", () => {
    typeInto(getBySelector<HTMLInputElement>('[role="combobox"]'), "new");
    expect(options()).toEqual(["Newer"]);
    click(getByText("Newer"));
    expect(handleSelect).toHaveBeenCalledWith("newer");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  test("New collection creates one in the active workspace and selects it", async () => {
    click(getByText("groupsPanel_newCollection"));
    typeInto(getBySelector<HTMLInputElement>("#collection-name"), "Ideas");
    await submitForm(getBySelector<HTMLFormElement>('[role="dialog"] form'));

    const created = app.useWorkspaceStore.getState().collections.find((collection) => collection.name === "Ideas");
    expect(created?.workspaceId).toBe("home");
    expect(handleSelect).toHaveBeenCalledWith(created?.id);
  });
});
```

Create `test/tag-picker.test.tsx`:

```tsx
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { click, getBySelector, installAppModules, pressKey, render, setupDom, teardownDom, typeInto, type AppModules, type RenderResult } from "./helpers/dom-environment";
import { makeTag } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
const handleChange = mock((_tagIds: string[]) => {});
let app: AppModules;
let TagPicker: typeof import("@/components/dashboard/shared/tag-picker").TagPicker;
let usePlanStore: typeof import("@/store/plan-store").usePlanStore;
let view: RenderResult | null = null;

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ usePlanStore } = await import("@/store/plan-store"));
  ({ TagPicker } = await importFresh<typeof import("@/components/dashboard/shared/tag-picker")>("components/dashboard/shared/tag-picker.tsx"));
});
afterAll(async () => {
  view?.unmount();
  replacer.restore();
  await teardownDom();
});
beforeEach(() => {
  view?.unmount();
  handleChange.mockClear();
  usePlanStore.setState({ limits: null, usage: null, fetchedAt: Date.now(), quotaAlert: null });
  app.useWorkspaceStore.setState({ tags: [makeTag("frontend", "Frontend"), makeTag("design", "Design")] });
  view = render(app, createElement(TagPicker, { value: ["design"], onChange: handleChange }));
});

const input = () => getBySelector<HTMLInputElement>('[role="combobox"]');

describe("TagPicker", () => {
  test("shows the selected tags as removable chips", () => {
    click(getBySelector('[aria-label="tagPicker_remove[Design]"]'));
    expect(handleChange).toHaveBeenCalledWith([]);
  });

  test("Enter picks the highlighted tag, reusing it regardless of case", () => {
    act(() => input().focus());
    typeInto(input(), "FRONT");
    pressKey(input(), "Enter");
    expect(handleChange).toHaveBeenCalledWith(["design", "frontend"]);
  });

  test("Enter on a new name creates the tag and adds it", () => {
    act(() => input().focus());
    typeInto(input(), "Reading");
    pressKey(input(), "Enter");
    const created = app.useWorkspaceStore.getState().tags.find((tag) => tag.name === "Reading");
    expect(created).toBeDefined();
    expect(handleChange).toHaveBeenCalledWith(["design", created?.id]);
  });

  test("a tag the quota blocks is not added", () => {
    usePlanStore.setState({
      limits: { max_bookmarks: 100, max_collections: 100, max_tags: 2, max_workspaces: 10, max_saved_groups: 100, trash_grace_days: 30 },
      usage: { bookmarks: 0, collections: 0, tags: 2, workspaces: 0, saved_groups: 0 },
      fetchedAt: Date.now(),
    });
    act(() => input().focus());
    typeInto(input(), "Reading");
    pressKey(input(), "Enter");
    expect(app.useWorkspaceStore.getState().tags).toHaveLength(2);
    expect(handleChange).not.toHaveBeenCalled();
    expect(usePlanStore.getState().quotaAlert).not.toBeNull();
  });

  test("Backspace in an empty field removes the last chip", () => {
    pressKey(input(), "Backspace");
    expect(handleChange).toHaveBeenCalledWith([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/tag-name.test.ts test/filterable-list.test.tsx test/collection-picker.test.tsx test/tag-picker.test.tsx`
Expected: FAIL — `Cannot find module '@/lib/tag-name'` and the missing component modules.

- [ ] **Step 3: Add the popover and the tag-name rules**

Create `components/ui/popover.tsx`:

```tsx
"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-72 origin-(--radix-popover-content-transform-origin) rounded-md border p-4 shadow-md outline-hidden",
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor }
```

Create `lib/tag-name.ts`:

```ts
export type TagNameError = "empty" | "duplicate";

/** A tag needs a name, and no other tag may have it, ignoring case and surrounding spaces. */
export function tagNameError(name: string, takenNames: readonly string[]): TagNameError | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return "empty";
  }
  const lower = trimmed.toLowerCase();
  return takenNames.some((taken) => taken.trim().toLowerCase() === lower) ? "duplicate" : null;
}
```

In `components/dashboard/sidebar/tag-dialog.tsx`, import `tagNameError` from `@/lib/tag-name` and replace the validation in `handleSubmit`:

```ts
  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problem = tagNameError(name, takenNames);
    if (problem) {
      setError(t(problem === "empty" ? "tagDialog_errorEmpty" : "tagDialog_errorDuplicate"));
      return;
    }
    onSubmit(name.trim(), color);
    onOpenChange(false);
  };
```

- [ ] **Step 4: Implement the filterable list**

Create `components/dashboard/shared/filterable-list.tsx`:

```tsx
import * as React from "react";
import { Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/hooks/use-translation";
import { cn } from "@/lib/utils";

export interface FilterableListItem {
  id: string;
  label: string;
}

export interface FilterableListCreate {
  /** Whether the trimmed, non-empty name may become a new item. */
  canCreate: (name: string) => boolean;
  onCreate: (name: string) => void;
}

interface FilterableListProps<T extends FilterableListItem> {
  items: readonly T[];
  query: string;
  onQueryChange: (query: string) => void;
  onActivate: (item: T) => void;
  /** Offers "Create «name»" when no item has the typed name and `canCreate` allows it. */
  create?: FilterableListCreate;
  /** Row content; the label by default. */
  renderItem?: (item: T) => React.ReactNode;
  /** Extra ARIA state for a row, e.g. aria-checked in a check list. */
  itemAria?: (item: T) => React.AriaAttributes;
  placeholder: string;
  emptyText: string;
  /** Hides the list, e.g. while a picker's field is not focused. */
  listHidden?: boolean;
  inputId?: string;
  autoFocus?: boolean;
  /** Runs before the list's own key handling; preventDefault takes the key over. */
  onInputKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onInputFocus?: () => void;
  onInputBlur?: () => void;
  className?: string;
  listClassName?: string;
}

type Row<T> = { kind: "item"; item: T } | { kind: "create"; name: string };

/**
 * A filter field over a listbox. Arrow keys move the highlight; Enter
 * activates it once the user typed or moved, so Enter in an untouched field
 * still reaches the surrounding form. Cmd/Ctrl+Enter is always left alone.
 */
export function FilterableList<T extends FilterableListItem>({
  items,
  query,
  onQueryChange,
  onActivate,
  create,
  renderItem,
  itemAria,
  placeholder,
  emptyText,
  listHidden = false,
  inputId,
  autoFocus,
  onInputKeyDown,
  onInputFocus,
  onInputBlur,
  className,
  listClassName,
}: FilterableListProps<T>) {
  const { t } = useTranslation();
  const listId = React.useId();
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [navigated, setNavigated] = React.useState(false);

  const rows = React.useMemo<Row<T>[]>(() => {
    const name = query.trim();
    const needle = name.toLowerCase();
    const matches = needle ? items.filter((item) => item.label.toLowerCase().includes(needle)) : items;
    const result = matches.map<Row<T>>((item) => ({ kind: "item", item }));
    const exists = items.some((item) => item.label.trim().toLowerCase() === needle);
    if (create && name && !exists && create.canCreate(name)) {
      result.push({ kind: "create", name });
    }
    return result;
  }, [items, query, create]);

  React.useEffect(() => {
    setActiveIndex(0);
    setNavigated(false);
  }, [query]);

  const highlighted = Math.min(activeIndex, rows.length - 1);

  const activateRow = (row: Row<T>) => {
    if (row.kind === "item") {
      onActivate(row.item);
    } else {
      create?.onCreate(row.name);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    onInputKeyDown?.(event);
    if (event.defaultPrevented) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setNavigated(true);
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex(Math.max(0, Math.min(highlighted + step, rows.length - 1)));
      return;
    }
    if (event.key !== "Enter" || event.metaKey || event.ctrlKey) {
      return;
    }
    const row = rows[highlighted];
    const typed = query.trim() !== "";
    if (row && (typed || navigated)) {
      event.preventDefault();
      activateRow(row);
    } else if (typed) {
      event.preventDefault();
    }
  };

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <Input
        id={inputId}
        role="combobox"
        aria-expanded={!listHidden}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={!listHidden && rows[highlighted] ? `${listId}-${highlighted}` : undefined}
        value={query}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={onInputFocus}
        onBlur={onInputBlur}
        className="h-8"
      />
      {!listHidden && (
        <div id={listId} role="listbox" className={cn("max-h-56 overflow-y-auto", listClassName)}>
          {rows.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{emptyText}</p>
          ) : (
            rows.map((row, index) => (
              <div
                key={row.kind === "item" ? row.item.id : "create"}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === highlighted}
                {...(row.kind === "item" ? itemAria?.(row.item) : undefined)}
                // Keep focus in the field, so a click does not close a picker that hides on blur.
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setActiveIndex(index)}
                onClick={() => activateRow(row)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
                  index === highlighted && "bg-accent text-accent-foreground",
                )}
              >
                {row.kind === "item" ? (
                  renderItem ? renderItem(row.item) : <span className="truncate">{row.item.label}</span>
                ) : (
                  <>
                    <Plus className="size-3.5 shrink-0" />
                    <span className="truncate">{t("filterableList_create", [row.name])}</span>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Implement the pickers**

Create `components/dashboard/shared/collection-picker.tsx`:

```tsx
import * as React from "react";
import { Check, FolderPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CollectionDialog } from "@/components/dashboard/sidebar/collection-dialog";
import { FilterableList } from "@/components/dashboard/shared/filterable-list";
import { useTranslation } from "@/hooks/use-translation";
import { getActiveWorkspaceCollections, isActiveWorkspace } from "@/lib/workspace-visibility";
import { useWorkspaceStore } from "@/store/workspace-store";

interface CollectionPickerProps {
  /** The collection shown as chosen; null when nothing is chosen, as in the bulk Move menu. */
  selectedId: string | null;
  onSelect: (collectionId: string) => void;
  /** The element that opens the picker, e.g. a button. */
  children: React.ReactElement;
  align?: "start" | "center" | "end";
}

/**
 * A searchable list of the active workspace's active collections (default
 * first, then newest) with "New collection…", which creates a collection in
 * the active workspace and selects it.
 */
export function CollectionPicker({ selectedId, onSelect, children, align = "start" }: CollectionPickerProps) {
  const { t } = useTranslation();
  const collections = useWorkspaceStore((s) => s.collections);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const createCollection = useWorkspaceStore((s) => s.createCollection);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [newCollectionOpen, setNewCollectionOpen] = React.useState(false);

  const items = React.useMemo(
    () => getActiveWorkspaceCollections(activeWorkspaceId, workspaces, collections)
      .map((collection) => ({ id: collection.id, label: collection.name })),
    [activeWorkspaceId, workspaces, collections],
  );

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery("");
    }
  };

  const handleActivate = (item: { id: string }) => {
    handleOpenChange(false);
    onSelect(item.id);
  };

  const handleNewCollection = (name: string, icon: string) => {
    const state = useWorkspaceStore.getState();
    const activeWorkspace = state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId);
    if (!isActiveWorkspace(activeWorkspace)) {
      return;
    }
    const collection = createCollection(state.activeWorkspaceId, name, icon);
    // An empty ID means the quota blocked it; the quota alert says so.
    if (collection.id) {
      onSelect(collection.id);
    }
  };

  return (
    <>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>{children}</PopoverTrigger>
        <PopoverContent align={align} className="w-64 p-2">
          <FilterableList
            items={items}
            query={query}
            onQueryChange={setQuery}
            onActivate={handleActivate}
            renderItem={(item) => (
              <>
                <span className="flex-1 truncate">{item.label}</span>
                {item.id === selectedId && <Check className="size-3.5 shrink-0" />}
              </>
            )}
            placeholder={t("collectionPicker_filterPlaceholder")}
            emptyText={t("collectionPicker_empty")}
            autoFocus
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-1 w-full justify-start"
            onClick={() => {
              handleOpenChange(false);
              setNewCollectionOpen(true);
            }}
          >
            <FolderPlus className="size-3.5" />
            {t("groupsPanel_newCollection")}
          </Button>
        </PopoverContent>
      </Popover>
      <CollectionDialog open={newCollectionOpen} onOpenChange={setNewCollectionOpen} onSubmit={handleNewCollection} />
    </>
  );
}
```

Create `components/dashboard/shared/tag-picker.tsx`:

```tsx
import * as React from "react";
import { X } from "lucide-react";
import { FilterableList } from "@/components/dashboard/shared/filterable-list";
import { useTranslation } from "@/hooks/use-translation";
import { tagNameError } from "@/lib/tag-name";
import type { Tag } from "@/lib/types";
import { cn } from "@/lib/utils";
import { TAG_COLORS, useWorkspaceStore } from "@/store/workspace-store";

interface TagPickerProps {
  /** Selected tag IDs, in the order they were added. */
  value: readonly string[];
  onChange: (tagIds: string[]) => void;
  inputId?: string;
  autoFocus?: boolean;
}

function solidColor(color: string): string {
  return color.split(" ")[0]?.replace("/10", "") ?? "bg-muted";
}

/**
 * Selected tags as removable chips plus a filter field. Enter picks the
 * highlighted tag or creates a new one; Backspace in an empty field removes
 * the last chip. A tag the quota blocks is not added.
 */
export function TagPicker({ value, onChange, inputId, autoFocus }: TagPickerProps) {
  const { t } = useTranslation();
  const tags = useWorkspaceStore((s) => s.tags);
  const createTag = useWorkspaceStore((s) => s.createTag);
  const [query, setQuery] = React.useState("");
  const [focused, setFocused] = React.useState(false);

  const tagsById = React.useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags]);
  const selectedTags = React.useMemo(
    () => value.map((id) => tagsById.get(id)).filter((tag): tag is Tag => tag !== undefined),
    [value, tagsById],
  );
  const items = React.useMemo(
    () => tags.filter((tag) => !value.includes(tag.id)).map((tag) => ({ id: tag.id, label: tag.name, color: tag.color })),
    [tags, value],
  );
  const tagNames = React.useMemo(() => tags.map((tag) => tag.name), [tags]);
  const create = React.useMemo(() => ({
    canCreate: (name: string) => tagNameError(name, tagNames) === null,
    onCreate: (name: string) => {
      const tag = createTag(name, TAG_COLORS[tags.length % TAG_COLORS.length]);
      // An empty ID means the quota blocked it; the quota alert says so.
      if (!tag.id) {
        return;
      }
      onChange([...value, tag.id]);
      setQuery("");
    },
  }), [tagNames, createTag, tags.length, onChange, value]);

  const handleActivate = (item: { id: string }) => {
    onChange([...value, item.id]);
    setQuery("");
  };

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Backspace" && query === "" && value.length > 0) {
      event.preventDefault();
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {selectedTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedTags.map((tag) => (
            <span
              key={tag.id}
              className={cn("inline-flex items-center gap-1 rounded-full py-0.5 pl-2.5 pr-1 text-xs font-medium", tag.color)}
            >
              {tag.name}
              <button
                type="button"
                aria-label={t("tagPicker_remove", [tag.name])}
                onClick={() => onChange(value.filter((id) => id !== tag.id))}
                className="rounded-full p-0.5 hover:bg-foreground/10"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <FilterableList
        items={items}
        query={query}
        onQueryChange={setQuery}
        onActivate={handleActivate}
        create={create}
        renderItem={(item) => (
          <>
            <span className={cn("size-2.5 shrink-0 rounded-full", solidColor(item.color))} />
            <span className="truncate">{item.label}</span>
          </>
        )}
        placeholder={t("tagPicker_placeholder")}
        emptyText={t("tagPicker_empty")}
        listHidden={!focused}
        inputId={inputId}
        autoFocus={autoFocus}
        onInputKeyDown={handleInputKeyDown}
        onInputFocus={() => setFocused(true)}
        onInputBlur={() => setFocused(false)}
        listClassName="rounded-md border p-1"
      />
    </div>
  );
}
```

Add to `public/_locales/en/messages.json`:

```json
  "filterableList_create": {
    "message": "Create “$1”",
    "placeholders": {
      "1": {
        "content": "$1"
      }
    }
  },
  "collectionPicker_filterPlaceholder": {
    "message": "Find a collection…"
  },
  "collectionPicker_empty": {
    "message": "No matching collections"
  },
  "tagPicker_placeholder": {
    "message": "Add tags…"
  },
  "tagPicker_empty": {
    "message": "No matching tags"
  },
  "tagPicker_remove": {
    "message": "Remove $1",
    "placeholders": {
      "1": {
        "content": "$1"
      }
    }
  },
```

Add to `public/_locales/zh_CN/messages.json`:

```json
  "filterableList_create": {
    "message": "创建“$1”",
    "placeholders": {
      "1": {
        "content": "$1"
      }
    }
  },
  "collectionPicker_filterPlaceholder": {
    "message": "查找收藏集…"
  },
  "collectionPicker_empty": {
    "message": "没有匹配的收藏集"
  },
  "tagPicker_placeholder": {
    "message": "添加标签…"
  },
  "tagPicker_empty": {
    "message": "没有匹配的标签"
  },
  "tagPicker_remove": {
    "message": "移除 $1",
    "placeholders": {
      "1": {
        "content": "$1"
      }
    }
  },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test test/tag-name.test.ts test/filterable-list.test.tsx test/collection-picker.test.tsx test/tag-picker.test.tsx test/tag-dialog.test.tsx test/sidebar-tags-section.test.tsx && bun run compile`
Expected: all pass; `tsc` exits 0.

- [ ] **Step 7: Commit**

```bash
git add components/ui/popover.tsx lib/tag-name.ts components/dashboard/sidebar/tag-dialog.tsx components/dashboard/shared/filterable-list.tsx components/dashboard/shared/collection-picker.tsx components/dashboard/shared/tag-picker.tsx test/helpers/dom-environment.ts public/_locales test/tag-name.test.ts test/filterable-list.test.tsx test/collection-picker.test.tsx test/tag-picker.test.tsx
git commit -m "feat(ui): searchable collection and tag pickers

Both build on one filterable listbox with keyboard navigation and an
optional create row; tag names follow the tag dialog's rules, which
now live in lib/tag-name.ts.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Part 4: Bulk actions

### Task 10: Bulk action bar with move, favorite, archive and delete

**Files:**
- Create: `components/dashboard/bulk-actions/bulk-notice.tsx`
- Create: `components/dashboard/bulk-actions/index.tsx`
- Modify: `components/dashboard/content.tsx` and `components/dashboard/favorites-content.tsx` (render the bar)
- Modify: both `messages.json`
- Test: `test/bulk-action-bar.test.tsx` (new); `test/bookmark-selection.test.tsx`

**Interfaces:**
- Consumes: `updateBookmarks`, `archiveBookmarks`, `trashBookmarks` (Task 5); `useSelectionStore`, `useSelectionOrders` (Task 7); `CollectionPicker` (Task 9).
- Produces: `BulkActionBar` (no props; reads the enclosing `SelectionOrdersProvider`; always mounted, renders the toolbar only while something is selected); `BulkNoticeContent { message: string; tone: "success" | "error"; link?: { label: string; to: string } }`, `useBulkNotice(): [BulkNoticeContent | null, (notice: BulkNoticeContent) => void]`, `BulkNotice`.

- [ ] **Step 1: Write the failing tests**

Create `test/bulk-action-bar.test.tsx`:

```tsx
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { click, getBySelector, getByText, installAppModules, render, setupDom, teardownDom, type AppModules, type RenderResult } from "./helpers/dom-environment";
import { bookmarkMap, countsByCollection, makeBookmark, makeCollection, makeWorkspace } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
let app: AppModules;
let BulkActionBar: typeof import("@/components/dashboard/bulk-actions").BulkActionBar;
let SelectionOrdersProvider: typeof import("@/components/dashboard/shared/selection-orders").SelectionOrdersProvider;
let useSelectionStore: typeof import("@/store/selection-store").useSelectionStore;
let view: RenderResult | null = null;
let retireMoveTargets = false;

const library = [
  makeBookmark("a", { title: "A", collectionId: "reading" }),
  makeBookmark("b", { title: "B", collectionId: "projects", isFavorite: true }),
  makeBookmark("c", { title: "C", collectionId: "reading" }),
];

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  const visibility = await importFresh<typeof import("@/lib/workspace-visibility")>("lib/workspace-visibility.ts");
  // Lets a test retire the Move target between choosing it and the move running.
  await replacer.replace("@/lib/workspace-visibility", {
    ...visibility,
    resolveActiveWorkspaceCollectionTarget: (...args: Parameters<typeof visibility.resolveActiveWorkspaceCollectionTarget>) =>
      retireMoveTargets ? undefined : visibility.resolveActiveWorkspaceCollectionTarget(...args),
  });
  ({ useSelectionStore } = await import("@/store/selection-store"));
  ({ SelectionOrdersProvider } = await import("@/components/dashboard/shared/selection-orders"));
  ({ BulkActionBar } = await importFresh<typeof import("@/components/dashboard/bulk-actions")>("components/dashboard/bulk-actions/index.tsx"));
});
afterAll(async () => {
  view?.unmount();
  replacer.restore();
  await teardownDom();
});

function renderBar(viewOrder: readonly string[] = ["a", "b", "c"], onScreenOrder: readonly string[] = viewOrder): void {
  view?.unmount();
  view = render(app, createElement(MemoryRouter, null, createElement(SelectionOrdersProvider, {
    viewOrder,
    onScreenOrder,
    children: createElement(BulkActionBar),
  })));
}

beforeEach(() => {
  retireMoveTargets = false;
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home", { name: "Home" })],
    collections: [
      makeCollection("reading", "home", { name: "Reading", isDefault: true }),
      makeCollection("projects", "home", { name: "Projects", position: 1 }),
    ],
    tags: [],
  });
  app.useBookmarksStore.setState({
    bookmarks: bookmarkMap(library),
    countsByCollection: countsByCollection(library),
    archivedBookmarks: [],
    trashedBookmarks: [],
    _archivedLoaded: true,
    _trashedLoaded: true,
  });
  act(() => {
    useSelectionStore.getState().clear();
  });
  renderBar();
});

function select(...ids: string[]): void {
  act(() => {
    useSelectionStore.getState().setMany(ids, true);
  });
}
const selected = () => [...useSelectionStore.getState().selectedIds].sort();
const bookmark = (id: string) => app.useBookmarksStore.getState().bookmarks.get(id);

describe("BulkActionBar", () => {
  test("appears with a selection and announces the count", () => {
    expect(document.querySelector('[role="toolbar"]')).toBeNull();
    select("a", "b");
    expect(getBySelector('[role="toolbar"]').getAttribute("aria-label")).toBe("bulkActions_toolbarLabel");
    expect(getBySelector('[aria-live="polite"]').textContent).toBe("bulkActions_selectedCount[2]");
  });

  test("Move to moves the bookmarks that live elsewhere and clears the selection", () => {
    select("a", "b");
    click(getByText("bulkActions_moveTo"));
    click(getByText("Projects"));

    expect(bookmark("a")?.collectionId).toBe("projects");
    expect(bookmark("b")?.updatedAt).toBeUndefined();
    expect(selected()).toEqual([]);
    expect(getBySelector('[role="status"]').textContent).toContain("bulkActions_movedOne[Projects]");
  });

  test("a Move target that is no longer available writes nothing and says so", () => {
    select("a");
    click(getByText("bulkActions_moveTo"));
    retireMoveTargets = true;
    click(getByText("Projects"));

    expect(bookmark("a")?.collectionId).toBe("reading");
    expect(selected()).toEqual(["a"]);
    expect(getBySelector('[role="status"]').textContent).toContain("workspaceVisibility_targetUnavailable");
  });

  test("Favorite favorites every bookmark unless all are favorites, and the label follows", () => {
    select("a", "b");
    click(getByText("bulkActions_favorite"));
    expect([bookmark("a")?.isFavorite, bookmark("b")?.isFavorite]).toEqual([true, true]);

    click(getByText("bulkActions_unfavorite"));
    expect([bookmark("a")?.isFavorite, bookmark("b")?.isFavorite]).toEqual([false, false]);
    expect(selected()).toEqual(["a", "b"]);
  });

  test("Archive archives the selection, clears it and links to the Archive page", () => {
    select("a", "c");
    click(getByText("bulkActions_archive"));

    const state = app.useBookmarksStore.getState();
    expect([...state.bookmarks.keys()]).toEqual(["b"]);
    expect(state.archivedBookmarks.map((archived) => archived.id)).toEqual(["a", "c"]);
    expect(selected()).toEqual([]);
    const notice = getBySelector('[role="status"]');
    expect(notice.textContent).toContain("bulkActions_archivedOther[2]");
    expect(notice.className).toContain("pointer-events-auto");
    expect(getBySelector('[role="status"] a').getAttribute("href")).toBe("/archive");
  });

  test("Delete moves the selection to the trash, clears it and links to the Trash page", () => {
    select("b");
    click(getByText("bulkActions_delete"));

    const state = app.useBookmarksStore.getState();
    expect(state.bookmarks.has("b")).toBe(false);
    expect(state.trashedBookmarks.map((trashed) => trashed.id)).toEqual(["b"]);
    expect(selected()).toEqual([]);
    expect(getBySelector('[role="status"]').textContent).toContain("bulkActions_trashedOne");
    expect(getBySelector('[role="status"] a').getAttribute("href")).toBe("/trash");
  });

  test("Select all selects the bookmarks on screen, not those in collapsed groups", () => {
    renderBar(["a", "b", "c"], ["a", "b"]);
    select("a");
    click(getByText("bulkActions_selectAll"));
    expect(selected()).toEqual(["a", "b"]);
  });

  test("the close button clears the selection", () => {
    select("a", "b");
    click(getBySelector('[aria-label="bulkActions_clear"]'));
    expect(selected()).toEqual([]);
    expect(document.querySelector('[role="toolbar"]')).toBeNull();
  });
});
```

Add to the `describe` in `test/bookmark-selection.test.tsx`:

```ts
  test("selecting a card shows the bulk action bar", () => {
    expect(document.querySelector('[role="toolbar"]')).toBeNull();
    click(checkbox("b"));
    expect(document.querySelector('[role="toolbar"]')).not.toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/bulk-action-bar.test.tsx test/bookmark-selection.test.tsx`
Expected: FAIL — `Cannot find module` for `components/dashboard/bulk-actions/index.tsx`, and no toolbar in the Favorites test.

- [ ] **Step 3: Implement the notice and the bar**

Create `components/dashboard/bulk-actions/bulk-notice.tsx`:

```tsx
import * as React from "react";
import { Link } from "react-router-dom";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

export interface BulkNoticeContent {
  message: string;
  tone: "success" | "error";
  /** A page that shows the result, e.g. the Archive. */
  link?: { label: string; to: string };
}

const NOTICE_DURATION_MS = 3000;

/** The current notice, and a function that shows a new one for three seconds. */
export function useBulkNotice(): [BulkNoticeContent | null, (notice: BulkNoticeContent) => void] {
  const [notice, setNotice] = React.useState<BulkNoticeContent | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
  }, []);

  const showNotice = React.useCallback((next: BulkNoticeContent) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    setNotice(next);
    timerRef.current = setTimeout(() => {
      setNotice(null);
      timerRef.current = null;
    }, NOTICE_DURATION_MS);
  }, []);

  return [notice, showNotice];
}

interface BulkNoticeProps {
  notice: BulkNoticeContent;
}

/** The floating notice from CLAUDE.md; it takes pointer events only when it has a link. */
export function BulkNotice({ notice }: BulkNoticeProps) {
  const Icon = notice.tone === "error" ? AlertCircle : CheckCircle2;
  return (
    <Alert
      role="status"
      variant={notice.tone === "error" ? "destructive" : "default"}
      className={cn(
        "fixed top-4 left-1/2 -translate-x-1/2 z-100 w-auto shadow-lg animate-in fade-in slide-in-from-top-2 whitespace-nowrap",
        notice.link ? "pointer-events-auto" : "pointer-events-none",
      )}
    >
      <Icon />
      <AlertDescription className="flex items-center gap-2">
        <span>{notice.message}</span>
        {notice.link && (
          <Link to={notice.link.to} className="font-medium text-foreground underline underline-offset-4">
            {notice.link.label}
          </Link>
        )}
      </AlertDescription>
    </Alert>
  );
}
```

Create `components/dashboard/bulk-actions/index.tsx`:

```tsx
import * as React from "react";
import { Archive, FolderInput, Heart, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CollectionPicker } from "@/components/dashboard/shared/collection-picker";
import { useSelectionOrders } from "@/components/dashboard/shared/selection-orders";
import { useTranslation } from "@/hooks/use-translation";
import type { Bookmark } from "@/lib/types";
import { cn } from "@/lib/utils";
import { resolveActiveWorkspaceCollectionTarget } from "@/lib/workspace-visibility";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useSelectionStore } from "@/store/selection-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { BulkNotice, useBulkNotice } from "./bulk-notice";

/** The active bookmarks behind `ids`, in the order of `ids`. */
function activeBookmarks(ids: Iterable<string>, bookmarks: ReadonlyMap<string, Bookmark>): Bookmark[] {
  const result: Bookmark[] = [];
  for (const id of ids) {
    const bookmark = bookmarks.get(id);
    if (bookmark) {
      result.push(bookmark);
    }
  }
  return result;
}

/**
 * The toolbar for the selection, stuck to the bottom of the view's scroll
 * container. It stays mounted while nothing is selected, so a notice outlives
 * the selection it reports on.
 */
export function BulkActionBar() {
  const { t } = useTranslation();
  const orders = useSelectionOrders();
  const selectedIds = useSelectionStore((s) => s.selectedIds);
  const setMany = useSelectionStore((s) => s.setMany);
  const clearSelection = useSelectionStore((s) => s.clear);
  const bookmarks = useBookmarksStore((s) => s.bookmarks);
  const updateBookmarks = useBookmarksStore((s) => s.updateBookmarks);
  const archiveBookmarks = useBookmarksStore((s) => s.archiveBookmarks);
  const trashBookmarks = useBookmarksStore((s) => s.trashBookmarks);
  const [notice, showNotice] = useBulkNotice();

  const selected = React.useMemo(() => activeBookmarks(selectedIds, bookmarks), [selectedIds, bookmarks]);
  const allFavorites = selected.length > 0 && selected.every((bookmark) => bookmark.isFavorite);
  const countText = selected.length > 0 ? t("bulkActions_selectedCount", [String(selected.length)]) : "";

  const handleMove = (collectionId: string) => {
    const state = useWorkspaceStore.getState();
    const target = resolveActiveWorkspaceCollectionTarget(collectionId, state.activeWorkspaceId, state.workspaces, state.collections);
    if (!target) {
      showNotice({ tone: "error", message: t("workspaceVisibility_targetUnavailable") });
      return;
    }
    const moving = selected.filter((bookmark) => bookmark.collectionId !== target.id);
    updateBookmarks(moving.map((bookmark) => ({ id: bookmark.id, patch: { collectionId: target.id } })));
    clearSelection();
    showNotice({
      tone: "success",
      message: moving.length === 1
        ? t("bulkActions_movedOne", [target.name])
        : t("bulkActions_movedOther", [String(moving.length), target.name]),
    });
  };

  const handleFavorite = () => {
    updateBookmarks(selected.map((bookmark) => ({ id: bookmark.id, patch: { isFavorite: !allFavorites } })));
  };

  const handleArchive = () => {
    archiveBookmarks(selected.map((bookmark) => bookmark.id));
    clearSelection();
    showNotice({
      tone: "success",
      message: selected.length === 1 ? t("bulkActions_archivedOne") : t("bulkActions_archivedOther", [String(selected.length)]),
      link: { label: t("bulkActions_viewArchive"), to: "/archive" },
    });
  };

  const handleDelete = () => {
    trashBookmarks(selected.map((bookmark) => bookmark.id));
    clearSelection();
    showNotice({
      tone: "success",
      message: selected.length === 1 ? t("bulkActions_trashedOne") : t("bulkActions_trashedOther", [String(selected.length)]),
      link: { label: t("bulkActions_viewTrash"), to: "/trash" },
    });
  };

  const handleSelectAll = () => {
    setMany(orders?.current.onScreenOrder ?? [], true);
  };

  return (
    <>
      {notice && <BulkNotice notice={notice} />}
      <div className="sr-only" aria-live="polite">{countText}</div>
      {selected.length > 0 && (
        <div className="pointer-events-none sticky bottom-0 z-20 flex justify-center px-4 pb-4">
          <div
            role="toolbar"
            aria-label={t("bulkActions_toolbarLabel")}
            className="pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-lg"
          >
            <span className="whitespace-nowrap px-2 text-sm font-medium">{countText}</span>
            <CollectionPicker selectedId={null} onSelect={handleMove} align="center">
              <Button type="button" variant="ghost" size="sm">
                <FolderInput className="size-4" />
                {t("bulkActions_moveTo")}
              </Button>
            </CollectionPicker>
            <Button type="button" variant="ghost" size="sm" onClick={handleFavorite}>
              <Heart className={cn("size-4", allFavorites && "fill-red-500 text-red-500")} />
              {t(allFavorites ? "bulkActions_unfavorite" : "bulkActions_favorite")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={handleArchive}>
              <Archive className="size-4" />
              {t("bulkActions_archive")}
            </Button>
            <Button type="button" variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={handleDelete}>
              <Trash2 className="size-4" />
              {t("bulkActions_delete")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={handleSelectAll}>
              {t("bulkActions_selectAll")}
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t("bulkActions_clear")} onClick={clearSelection}>
              <X className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 4: Render the bar in both views**

In `components/dashboard/content.tsx`, import `BulkActionBar` from `@/components/dashboard/bulk-actions` and render it as the last child of the scroll container, after the `div` whose height is `virtualizer.getTotalSize()`:

```tsx
        </div>

        <BulkActionBar />
```

In `components/dashboard/favorites-content.tsx`, import it the same way and render it as the last child of `<div className="flex-1 w-full overflow-auto">`, after the `p-4 md:p-6 space-y-6` block.

Add to `public/_locales/en/messages.json`:

```json
  "bulkActions_toolbarLabel": {
    "message": "Bulk actions"
  },
  "bulkActions_selectedCount": {
    "message": "$1 selected",
    "placeholders": {
      "1": {
        "content": "$1"
      }
    }
  },
  "bulkActions_moveTo": {
    "message": "Move to…"
  },
  "bulkActions_favorite": {
    "message": "Favorite"
  },
  "bulkActions_unfavorite": {
    "message": "Unfavorite"
  },
  "bulkActions_archive": {
    "message": "Archive"
  },
  "bulkActions_delete": {
    "message": "Delete"
  },
  "bulkActions_selectAll": {
    "message": "Select all"
  },
  "bulkActions_clear": {
    "message": "Clear selection"
  },
  "bulkActions_movedOne": {
    "message": "Moved 1 bookmark to $1",
    "placeholders": {
      "1": {
        "content": "$1"
      }
    }
  },
  "bulkActions_movedOther": {
    "message": "Moved $1 bookmarks to $2",
    "placeholders": {
      "1": {
        "content": "$1"
      },
      "2": {
        "content": "$2"
      }
    }
  },
  "bulkActions_archivedOne": {
    "message": "Archived 1 bookmark"
  },
  "bulkActions_archivedOther": {
    "message": "Archived $1 bookmarks",
    "placeholders": {
      "1": {
        "content": "$1"
      }
    }
  },
  "bulkActions_trashedOne": {
    "message": "Moved 1 bookmark to Trash"
  },
  "bulkActions_trashedOther": {
    "message": "Moved $1 bookmarks to Trash",
    "placeholders": {
      "1": {
        "content": "$1"
      }
    }
  },
  "bulkActions_viewArchive": {
    "message": "Open Archive"
  },
  "bulkActions_viewTrash": {
    "message": "Open Trash"
  },
```

Add to `public/_locales/zh_CN/messages.json`:

```json
  "bulkActions_toolbarLabel": {
    "message": "批量操作"
  },
  "bulkActions_selectedCount": {
    "message": "已选择 $1 项",
    "placeholders": {
      "1": {
        "content": "$1"
      }
    }
  },
  "bulkActions_moveTo": {
    "message": "移动到…"
  },
  "bulkActions_favorite": {
    "message": "收藏"
  },
  "bulkActions_unfavorite": {
    "message": "取消收藏"
  },
  "bulkActions_archive": {
    "message": "归档"
  },
  "bulkActions_delete": {
    "message": "删除"
  },
  "bulkActions_selectAll": {
    "message": "全选"
  },
  "bulkActions_clear": {
    "message": "取消选择"
  },
  "bulkActions_movedOne": {
    "message": "已将 1 个书签移动到 $1",
    "placeholders": {
      "1": {
        "content": "$1"
      }
    }
  },
  "bulkActions_movedOther": {
    "message": "已将 $1 个书签移动到 $2",
    "placeholders": {
      "1": {
        "content": "$1"
      },
      "2": {
        "content": "$2"
      }
    }
  },
  "bulkActions_archivedOne": {
    "message": "已归档 1 个书签"
  },
  "bulkActions_archivedOther": {
    "message": "已归档 $1 个书签",
    "placeholders": {
      "1": {
        "content": "$1"
      }
    }
  },
  "bulkActions_trashedOne": {
    "message": "已将 1 个书签移到回收站"
  },
  "bulkActions_trashedOther": {
    "message": "已将 $1 个书签移到回收站",
    "placeholders": {
      "1": {
        "content": "$1"
      }
    }
  },
  "bulkActions_viewArchive": {
    "message": "查看归档"
  },
  "bulkActions_viewTrash": {
    "message": "查看回收站"
  },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/bulk-action-bar.test.tsx test/bookmark-selection.test.tsx test/library-selection.test.tsx test/library-visible-filters.test.tsx && bun run compile`
Expected: all pass; `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add components/dashboard/bulk-actions components/dashboard/content.tsx components/dashboard/favorites-content.tsx public/_locales test/bulk-action-bar.test.tsx test/bookmark-selection.test.tsx
git commit -m "feat(bookmarks): bulk move, favorite, archive and delete

A toolbar sticks to the bottom of the library and Favorites while
bookmarks are selected. Archive and Delete notices link to the pages
where the bookmarks can be restored.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: Bulk Tags menu

**Files:**
- Create: `lib/bulk-tags.ts`
- Create: `components/dashboard/bulk-actions/tags-menu.tsx`
- Modify: `components/dashboard/bulk-actions/index.tsx` (render the menu after Move to…)
- Modify: both `messages.json`
- Test: `test/bulk-tags.test.ts`, `test/bulk-tags-menu.test.tsx` (new)

**Interfaces:**
- Consumes: `FilterableList` (Task 9), `tagNameError` (Task 9), `updateBookmarks` (Task 5), `BookmarkPatchEntry` (Task 3).
- Produces: `TagCheckState = "checked" | "indeterminate" | "unchecked"`; `tagCheckStates(bookmarks, tagIds): Map<string, TagCheckState>`; `nextTagCheckState(state): TagCheckState`; `bulkTagPatches(bookmarks, changes: ReadonlyMap<string, TagCheckState>): BookmarkPatchEntry[]`; `BulkTagsMenu` with prop `bookmarks: readonly Bookmark[]`.

- [ ] **Step 1: Write the failing tests**

Create `test/bulk-tags.test.ts`:

```ts
// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import { bulkTagPatches, nextTagCheckState, tagCheckStates } from "@/lib/bulk-tags";
import { makeBookmark } from "./helpers/library-fixtures";

const a = makeBookmark("a", { tags: ["frontend", "design"] });
const b = makeBookmark("b", { tags: ["frontend"] });

describe("bulk tags", () => {
  test("a tag is checked when every bookmark has it, mixed when some do, empty when none do", () => {
    expect(Object.fromEntries(tagCheckStates([a, b], ["frontend", "design", "docs"]))).toEqual({
      frontend: "checked",
      design: "indeterminate",
      docs: "unchecked",
    });
  });

  test("a click checks an empty or mixed box and empties a checked one", () => {
    expect(nextTagCheckState("unchecked")).toBe("checked");
    expect(nextTagCheckState("indeterminate")).toBe("checked");
    expect(nextTagCheckState("checked")).toBe("unchecked");
  });

  test("checked rows add the tag to every bookmark and unchecked rows remove it", () => {
    const changes = new Map([["design", "checked" as const], ["frontend", "unchecked" as const]]);
    expect(bulkTagPatches([a, b], changes)).toEqual([
      { id: "a", patch: { tags: ["design"] } },
      { id: "b", patch: { tags: ["design"] } },
    ]);
  });

  test("untouched tags keep each bookmark's state", () => {
    expect(bulkTagPatches([a, b], new Map([["docs", "checked" as const]]))).toEqual([
      { id: "a", patch: { tags: ["frontend", "design", "docs"] } },
      { id: "b", patch: { tags: ["frontend", "docs"] } },
    ]);
  });

  test("bookmarks whose tags would not change get no patch", () => {
    expect(bulkTagPatches([a, b], new Map([["frontend", "checked" as const]]))).toEqual([]);
  });
});
```

Create `test/bulk-tags-menu.test.tsx`:

```tsx
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { click, getBySelector, getByText, installAppModules, pressKey, render, setupDom, teardownDom, typeInto, type AppModules, type RenderResult } from "./helpers/dom-environment";
import { bookmarkMap, countsByCollection, makeBookmark, makeCollection, makeTag, makeWorkspace } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
let app: AppModules;
let BulkActionBar: typeof import("@/components/dashboard/bulk-actions").BulkActionBar;
let SelectionOrdersProvider: typeof import("@/components/dashboard/shared/selection-orders").SelectionOrdersProvider;
let useSelectionStore: typeof import("@/store/selection-store").useSelectionStore;
let usePlanStore: typeof import("@/store/plan-store").usePlanStore;
let view: RenderResult | null = null;

const library = [
  makeBookmark("a", { collectionId: "reading", tags: ["frontend", "design"] }),
  makeBookmark("b", { collectionId: "reading", tags: ["frontend"] }),
];

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ useSelectionStore } = await import("@/store/selection-store"));
  ({ usePlanStore } = await import("@/store/plan-store"));
  ({ SelectionOrdersProvider } = await import("@/components/dashboard/shared/selection-orders"));
  ({ BulkActionBar } = await importFresh<typeof import("@/components/dashboard/bulk-actions")>("components/dashboard/bulk-actions/index.tsx"));
});
afterAll(async () => {
  view?.unmount();
  replacer.restore();
  await teardownDom();
});
beforeEach(() => {
  view?.unmount();
  usePlanStore.setState({ limits: null, usage: null, fetchedAt: Date.now(), quotaAlert: null });
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home")],
    collections: [makeCollection("reading", "home", { isDefault: true })],
    tags: [makeTag("frontend", "Frontend"), makeTag("design", "Design"), makeTag("docs", "Docs")],
  });
  app.useBookmarksStore.setState({ bookmarks: bookmarkMap(library), countsByCollection: countsByCollection(library) });
  act(() => {
    useSelectionStore.getState().clear();
    useSelectionStore.getState().setMany(["a", "b"], true);
  });
  view = render(app, createElement(MemoryRouter, null, createElement(SelectionOrdersProvider, {
    viewOrder: ["a", "b"],
    onScreenOrder: ["a", "b"],
    children: createElement(BulkActionBar),
  })));
  click(getByText("bulkActions_tags"));
});

const row = (name: string) => getByText(name).closest('[role="option"]');
const tagsOf = (id: string) => app.useBookmarksStore.getState().bookmarks.get(id)?.tags;

describe("bulk Tags menu", () => {
  test("rows show checked, mixed and empty states from the selection", () => {
    expect(row("Frontend")?.getAttribute("aria-checked")).toBe("true");
    expect(row("Design")?.getAttribute("aria-checked")).toBe("mixed");
    expect(row("Docs")?.getAttribute("aria-checked")).toBe("false");
  });

  test("clicked rows apply to the whole selection in one update, and the selection stays", () => {
    click(getByText("Design"));
    click(getByText("Frontend"));
    expect(row("Design")?.getAttribute("aria-checked")).toBe("true");
    expect(row("Frontend")?.getAttribute("aria-checked")).toBe("false");

    click(getByText("bulkTags_apply"));

    expect(tagsOf("a")).toEqual(["design"]);
    expect(tagsOf("b")).toEqual(["design"]);
    expect([...useSelectionStore.getState().selectedIds].sort()).toEqual(["a", "b"]);
  });

  test("untouched rows keep each bookmark's tags", () => {
    click(getByText("Docs"));
    click(getByText("bulkTags_apply"));
    expect(tagsOf("a")).toEqual(["frontend", "design", "docs"]);
    expect(tagsOf("b")).toEqual(["frontend", "docs"]);
  });

  test("a new tag is created and checked for the whole selection", () => {
    typeInto(getBySelector<HTMLInputElement>('[role="combobox"]'), "Reading");
    pressKey(getBySelector('[role="combobox"]'), "Enter");
    const created = app.useWorkspaceStore.getState().tags.find((tag) => tag.name === "Reading");
    expect(created).toBeDefined();

    click(getByText("bulkTags_apply"));

    expect(tagsOf("a")).toContain(created?.id);
    expect(tagsOf("b")).toContain(created?.id);
  });

  test("a tag the quota blocks is not added", () => {
    usePlanStore.setState({
      limits: { max_bookmarks: 100, max_collections: 100, max_tags: 3, max_workspaces: 10, max_saved_groups: 100, trash_grace_days: 30 },
      usage: { bookmarks: 2, collections: 1, tags: 3, workspaces: 1, saved_groups: 0 },
      fetchedAt: Date.now(),
    });
    typeInto(getBySelector<HTMLInputElement>('[role="combobox"]'), "Reading");
    pressKey(getBySelector('[role="combobox"]'), "Enter");

    expect(app.useWorkspaceStore.getState().tags).toHaveLength(3);
    expect(usePlanStore.getState().quotaAlert).not.toBeNull();
    expect(getByText("bulkTags_apply").closest("button")?.disabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/bulk-tags.test.ts test/bulk-tags-menu.test.tsx`
Expected: FAIL — `Cannot find module '@/lib/bulk-tags'` and `No element with text "bulkActions_tags"`.

- [ ] **Step 3: Implement the tag computation and the menu**

Create `lib/bulk-tags.ts`:

```ts
import type { Bookmark, BookmarkPatchEntry } from "@/lib/types";

export type TagCheckState = "checked" | "indeterminate" | "unchecked";

/** For each tag: checked when every bookmark has it, indeterminate when some do, unchecked when none do. */
export function tagCheckStates(bookmarks: readonly Bookmark[], tagIds: readonly string[]): Map<string, TagCheckState> {
  const states = new Map<string, TagCheckState>();
  for (const tagId of tagIds) {
    const count = bookmarks.filter((bookmark) => bookmark.tags.includes(tagId)).length;
    states.set(tagId, count === 0 ? "unchecked" : count === bookmarks.length ? "checked" : "indeterminate");
  }
  return states;
}

/** A click checks an empty or mixed box (add to all) and empties a checked one (remove from all). */
export function nextTagCheckState(state: TagCheckState): TagCheckState {
  return state === "checked" ? "unchecked" : "checked";
}

/**
 * Turns the rows the user changed into per-bookmark patches: a checked row
 * adds its tag to every bookmark, an unchecked row removes it. Tags the user
 * did not touch keep each bookmark's state, and bookmarks whose tags do not
 * change get no patch.
 */
export function bulkTagPatches(
  bookmarks: readonly Bookmark[],
  changes: ReadonlyMap<string, TagCheckState>,
): BookmarkPatchEntry[] {
  const patches: BookmarkPatchEntry[] = [];
  for (const bookmark of bookmarks) {
    const tags = bookmark.tags.filter((tagId) => changes.get(tagId) !== "unchecked");
    for (const [tagId, state] of changes) {
      if (state === "checked" && !tags.includes(tagId)) {
        tags.push(tagId);
      }
    }
    const unchanged = tags.length === bookmark.tags.length && tags.every((tagId, index) => tagId === bookmark.tags[index]);
    if (!unchanged) {
      patches.push({ id: bookmark.id, patch: { tags } });
    }
  }
  return patches;
}
```

Create `components/dashboard/bulk-actions/tags-menu.tsx`:

```tsx
import * as React from "react";
import { Check, Minus, Tag as TagIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { FilterableList } from "@/components/dashboard/shared/filterable-list";
import { useTranslation } from "@/hooks/use-translation";
import { bulkTagPatches, nextTagCheckState, tagCheckStates, type TagCheckState } from "@/lib/bulk-tags";
import { tagNameError } from "@/lib/tag-name";
import type { Bookmark } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { TAG_COLORS, useWorkspaceStore } from "@/store/workspace-store";

interface BulkTagsMenuProps {
  /** The selected bookmarks. */
  bookmarks: readonly Bookmark[];
}

function ariaChecked(state: TagCheckState): boolean | "mixed" {
  return state === "indeterminate" ? "mixed" : state === "checked";
}

interface TagCheckRowProps {
  state: TagCheckState;
  label: string;
}

function TagCheckRow({ state, label }: TagCheckRowProps) {
  return (
    <>
      <span
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-sm border",
          state === "unchecked" ? "border-muted-foreground/60" : "border-primary bg-primary text-primary-foreground",
        )}
      >
        {state === "checked" && <Check className="size-3" />}
        {state === "indeterminate" && <Minus className="size-3" />}
      </span>
      <span className="truncate">{label}</span>
    </>
  );
}

/**
 * Three-state tag rows computed from the selection. Rows the user clicks are
 * applied to every selected bookmark in one update when they press Apply;
 * other rows keep each bookmark's tags.
 */
export function BulkTagsMenu({ bookmarks }: BulkTagsMenuProps) {
  const { t } = useTranslation();
  const tags = useWorkspaceStore((s) => s.tags);
  const createTag = useWorkspaceStore((s) => s.createTag);
  const updateBookmarks = useBookmarksStore((s) => s.updateBookmarks);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [changes, setChanges] = React.useState<ReadonlyMap<string, TagCheckState>>(new Map());

  const initial = React.useMemo(() => tagCheckStates(bookmarks, tags.map((tag) => tag.id)), [bookmarks, tags]);
  const items = React.useMemo(() => tags.map((tag) => ({ id: tag.id, label: tag.name })), [tags]);
  const tagNames = React.useMemo(() => tags.map((tag) => tag.name), [tags]);
  const stateOf = (tagId: string): TagCheckState => changes.get(tagId) ?? initial.get(tagId) ?? "unchecked";

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery("");
      setChanges(new Map());
    }
  };

  const handleToggle = (item: { id: string }) => {
    setChanges((current) => new Map(current).set(item.id, nextTagCheckState(current.get(item.id) ?? initial.get(item.id) ?? "unchecked")));
  };

  const create = {
    canCreate: (name: string) => tagNameError(name, tagNames) === null,
    onCreate: (name: string) => {
      const tag = createTag(name, TAG_COLORS[tags.length % TAG_COLORS.length]);
      // An empty ID means the quota blocked it; the quota alert says so.
      if (!tag.id) {
        return;
      }
      setChanges((current) => new Map(current).set(tag.id, "checked"));
      setQuery("");
    },
  };

  const handleApply = () => {
    updateBookmarks(bulkTagPatches(bookmarks, changes));
    handleOpenChange(false);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          <TagIcon className="size-4" />
          {t("bulkActions_tags")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-64 p-2">
        <FilterableList
          items={items}
          query={query}
          onQueryChange={setQuery}
          onActivate={handleToggle}
          create={create}
          renderItem={(item) => <TagCheckRow state={stateOf(item.id)} label={item.label} />}
          itemAria={(item) => ({ "aria-checked": ariaChecked(stateOf(item.id)) })}
          placeholder={t("bulkTags_filterPlaceholder")}
          emptyText={t("bulkTags_empty")}
          autoFocus
        />
        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
            {t("settings_cancel")}
          </Button>
          <Button type="button" size="sm" disabled={changes.size === 0} onClick={handleApply}>
            {t("bulkTags_apply")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
```

In `components/dashboard/bulk-actions/index.tsx`, import `BulkTagsMenu` from `./tags-menu` and render it right after the `CollectionPicker`:

```tsx
            <BulkTagsMenu bookmarks={selected} />
```

Add to `public/_locales/en/messages.json`:

```json
  "bulkActions_tags": {
    "message": "Tags…"
  },
  "bulkTags_filterPlaceholder": {
    "message": "Find or create a tag…"
  },
  "bulkTags_empty": {
    "message": "No matching tags"
  },
  "bulkTags_apply": {
    "message": "Apply"
  },
```

Add to `public/_locales/zh_CN/messages.json`:

```json
  "bulkActions_tags": {
    "message": "标签…"
  },
  "bulkTags_filterPlaceholder": {
    "message": "查找或创建标签…"
  },
  "bulkTags_empty": {
    "message": "没有匹配的标签"
  },
  "bulkTags_apply": {
    "message": "应用"
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/bulk-tags.test.ts test/bulk-tags-menu.test.tsx test/bulk-action-bar.test.tsx && bun run compile`
Expected: all pass; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add lib/bulk-tags.ts components/dashboard/bulk-actions public/_locales test/bulk-tags.test.ts test/bulk-tags-menu.test.tsx
git commit -m "feat(bookmarks): add and remove tags across a selection

The Tags menu shows each tag as checked, mixed or empty for the
selection, and Apply writes every change in one batch update.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: Open and copy a selection

**Files:**
- Modify: `lib/chrome/tabs.ts` (new `openUrlsInBackground` after `openUrls`)
- Modify: `store/tabs-store.ts` (new `openUrlsAsGroup`; `openCollectionAsGroup` uses it)
- Create: `lib/bookmark-clipboard.ts`
- Create: `components/dashboard/bulk-actions/open-tabs-confirm-dialog.tsx`
- Modify: `components/dashboard/bulk-actions/index.tsx`
- Modify: both `messages.json`
- Test: `test/bookmark-clipboard.test.ts`, `test/chrome-tabs-background.test.ts`, `test/bulk-open-copy.test.tsx` (new)

**Interfaces:**
- Produces: `openUrlsInBackground(urls: readonly string[]): Promise<void>`; `useTabsStore.openUrlsAsGroup(urls: string[], title: string, color: TabGroupColor, compact?: boolean): Promise<void>`; `formatLinkList(bookmarks): string`, `formatMarkdownLinkList(bookmarks): string`; `OpenTabsConfirmDialog` (props `count`, `open`, `onOpenChange`, `onConfirm`).

- [ ] **Step 1: Write the failing tests**

Create `test/bookmark-clipboard.test.ts`:

```ts
// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import { formatLinkList, formatMarkdownLinkList } from "@/lib/bookmark-clipboard";

describe("bookmark link lists", () => {
  test("plain links are one URL per line", () => {
    expect(formatLinkList([{ url: "https://a.example" }, { url: "https://b.example/x" }])).toBe("https://a.example\nhttps://b.example/x");
  });

  test("a Markdown list escapes link text and percent-encodes the characters that end a link target", () => {
    expect(formatMarkdownLinkList([
      { title: "Docs [beta] \\ notes", url: "https://example.com/a b(c)" },
      { title: "Line one\nLine two\r\nLine three", url: "https://example.com/x" },
    ])).toBe(
      "- [Docs \\[beta\\] \\\\ notes](https://example.com/a%20b%28c%29)\n" +
      "- [Line one Line two Line three](https://example.com/x)",
    );
  });
});
```

Create `test/chrome-tabs-background.test.ts`:

```ts
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { importFresh } from "./helpers/module-replacer";

const originalChrome = Reflect.get(globalThis, "chrome");
const created: chrome.tabs.CreateProperties[] = [];
let openUrlsInBackground: typeof import("@/lib/chrome/tabs").openUrlsInBackground;

beforeAll(async () => {
  Reflect.set(globalThis, "chrome", {
    tabs: {
      create: async (properties: chrome.tabs.CreateProperties) => {
        created.push(properties);
        return { id: created.length };
      },
    },
  });
  ({ openUrlsInBackground } = await importFresh<typeof import("@/lib/chrome/tabs")>("lib/chrome/tabs.ts"));
});
afterAll(() => {
  Reflect.set(globalThis, "chrome", originalChrome);
});

test("opens each URL in order as a background tab", async () => {
  await openUrlsInBackground(["https://a.example", "https://b.example"]);
  expect(created).toEqual([
    { url: "https://a.example", active: false },
    { url: "https://b.example", active: false },
  ]);
});
```

Create `test/bulk-open-copy.test.tsx`:

```tsx
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { click, getBySelector, getByText, installAppModules, openDropdown, render, setupDom, teardownDom, wait, type AppModules, type RenderResult } from "./helpers/dom-environment";
import { bookmarkMap, countsByCollection, makeBookmark, makeCollection, makeWorkspace } from "./helpers/library-fixtures";
import type { Bookmark } from "@/lib/types";

const replacer = createModuleReplacer();
const openUrlsInBackground = mock(async (_urls: readonly string[]) => {});
const openAsTabGroup = mock(async (_urls: string[], _title: string, _color: string) => 7);
const copied: string[] = [];
let clipboardFails = false;
let app: AppModules;
let BulkActionBar: typeof import("@/components/dashboard/bulk-actions").BulkActionBar;
let SelectionOrdersProvider: typeof import("@/components/dashboard/shared/selection-orders").SelectionOrdersProvider;
let useSelectionStore: typeof import("@/store/selection-store").useSelectionStore;
let view: RenderResult | null = null;

const reading = [
  makeBookmark("a", { title: "Docs [beta]", url: "https://example.com/a b", collectionId: "reading" }),
  makeBookmark("c", { title: "C", url: "https://example.com/c", collectionId: "reading" }),
];
const project = makeBookmark("b", { title: "B", url: "https://example.com/b", collectionId: "projects" });

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  const realTabs = await importFresh<typeof import("@/lib/chrome/tabs")>("lib/chrome/tabs.ts");
  await replacer.replace("@/lib/chrome/tabs", { ...realTabs, openUrlsInBackground, getCurrentWindowTabs: async () => [] });
  const realGroups = await importFresh<typeof import("@/lib/chrome/tab-groups")>("lib/chrome/tab-groups.ts");
  await replacer.replace("@/lib/chrome/tab-groups", { ...realGroups, openAsTabGroup, getCurrentWindowGroups: async () => [] });
  await replacer.replace("@/store/tabs-store", await importFresh<typeof import("@/store/tabs-store")>("store/tabs-store.ts"));
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        if (clipboardFails) {
          throw new Error("Clipboard write denied");
        }
        copied.push(text);
      },
    },
  });
  ({ useSelectionStore } = await import("@/store/selection-store"));
  ({ SelectionOrdersProvider } = await import("@/components/dashboard/shared/selection-orders"));
  ({ BulkActionBar } = await importFresh<typeof import("@/components/dashboard/bulk-actions")>("components/dashboard/bulk-actions/index.tsx"));
});
afterAll(async () => {
  view?.unmount();
  Reflect.deleteProperty(navigator, "clipboard");
  replacer.restore();
  await teardownDom();
});

function renderBar(bookmarks: Bookmark[], viewOrder: readonly string[], selectedIds: readonly string[]): void {
  view?.unmount();
  app.useBookmarksStore.setState({ bookmarks: bookmarkMap(bookmarks), countsByCollection: countsByCollection(bookmarks) });
  act(() => {
    useSelectionStore.getState().clear();
    useSelectionStore.getState().setMany(selectedIds, true);
  });
  view = render(app, createElement(MemoryRouter, null, createElement(SelectionOrdersProvider, {
    viewOrder,
    onScreenOrder: viewOrder,
    children: createElement(BulkActionBar),
  })));
}

beforeEach(() => {
  openUrlsInBackground.mockClear();
  openAsTabGroup.mockClear();
  copied.length = 0;
  clipboardFails = false;
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home", { name: "Home" })],
    collections: [
      makeCollection("reading", "home", { name: "Reading", isDefault: true }),
      makeCollection("projects", "home", { name: "Projects", position: 1 }),
    ],
    compactGroupTitles: false,
  });
});

async function chooseFromMenu(trigger: Element, item: string): Promise<void> {
  await act(async () => {
    openDropdown(trigger);
  });
  click(getByText(item));
  await wait(0);
}
const openMenu = () => getByText("bulkActions_open");
const moreMenu = () => getBySelector('[aria-label="bulkActions_more"]');

describe("opening a selection", () => {
  test("Open all in new tabs opens the selection in view order as background tabs", async () => {
    renderBar([...reading, project], ["c", "b", "a"], ["a", "c"]);
    await chooseFromMenu(openMenu(), "bulkActions_openAll");
    expect(openUrlsInBackground.mock.calls[0]?.[0]).toEqual(["https://example.com/c", "https://example.com/a b"]);
  });

  test("more than 10 tabs ask first", async () => {
    const many = Array.from({ length: 11 }, (_, index) => makeBookmark(`m${index}`, { collectionId: "reading" }));
    const ids = many.map((bookmark) => bookmark.id);
    renderBar(many, ids, ids);

    await chooseFromMenu(openMenu(), "bulkActions_openAll");
    expect(getBySelector('[role="dialog"]').textContent).toContain("bulkActions_confirmOpenTitle[11]");
    expect(openUrlsInBackground).not.toHaveBeenCalled();

    click(getByText("bulkActions_confirmOpen"));
    await wait(0);
    expect(openUrlsInBackground.mock.calls[0]?.[0]).toHaveLength(11);
  });

  test("a tab group takes the shared collection's name, otherwise the workspace's", async () => {
    renderBar([...reading, project], ["a", "c", "b"], ["a", "c"]);
    await chooseFromMenu(openMenu(), "bulkActions_openAsGroup");
    expect(openAsTabGroup.mock.calls[0]).toEqual([["https://example.com/a b", "https://example.com/c"], "Reading", "grey"]);

    renderBar([...reading, project], ["a", "c", "b"], ["a", "b"]);
    await chooseFromMenu(openMenu(), "bulkActions_openAsGroup");
    expect(openAsTabGroup.mock.calls[1]?.[1]).toBe("Home");
  });

  test("a failure to open tabs shows a notice", async () => {
    openUrlsInBackground.mockImplementationOnce(async () => {
      throw new Error("Tabs are blocked");
    });
    renderBar(reading, ["a", "c"], ["a"]);
    await chooseFromMenu(openMenu(), "bulkActions_openAll");
    expect(getBySelector('[role="status"]').textContent).toContain("bulkActions_openFailed");
  });
});

describe("copying a selection", () => {
  test("Copy links writes one URL per line in view order and says how many", async () => {
    renderBar(reading, ["c", "a"], ["a", "c"]);
    await chooseFromMenu(moreMenu(), "bulkActions_copyLinks");
    expect(copied).toEqual(["https://example.com/c\nhttps://example.com/a b"]);
    expect(getBySelector('[role="status"]').textContent).toContain("bulkActions_copiedOther[2]");
  });

  test("Copy as Markdown list escapes titles and URLs", async () => {
    renderBar(reading, ["a"], ["a"]);
    await chooseFromMenu(moreMenu(), "bulkActions_copyMarkdown");
    expect(copied).toEqual(["- [Docs \\[beta\\]](https://example.com/a%20b)"]);
    expect(getBySelector('[role="status"]').textContent).toContain("bulkActions_copiedOne");
  });

  test("a clipboard failure shows a notice", async () => {
    clipboardFails = true;
    renderBar(reading, ["a"], ["a"]);
    await chooseFromMenu(moreMenu(), "bulkActions_copyLinks");
    expect(getBySelector('[role="status"]').textContent).toContain("bulkActions_copyFailed");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/bookmark-clipboard.test.ts test/chrome-tabs-background.test.ts test/bulk-open-copy.test.tsx`
Expected: FAIL — `Cannot find module '@/lib/bookmark-clipboard'`, `openUrlsInBackground is not a function`, and no `bulkActions_open` button.

- [ ] **Step 3: Implement background tabs, groups and link lists**

In `lib/chrome/tabs.ts`, add after `openUrls`:

```ts
/** Open URLs, in order, as background tabs in the current window. */
export async function openUrlsInBackground(urls: readonly string[]): Promise<void> {
  for (const url of urls) {
    await chrome.tabs.create({ url, active: false });
  }
}
```

In `store/tabs-store.ts`, add to the interface after `openCollectionAsGroup`:

```ts
  /** Opens URLs as background tabs in a new group, honoring the compact-title setting. */
  openUrlsAsGroup: (urls: string[], title: string, color: TabGroupColor, compact?: boolean) => Promise<void>;
```

Replace the `openCollectionAsGroup` implementation and add `openUrlsAsGroup` before it:

```ts
  openUrlsAsGroup: async (urls, title, color, compact) => {
    if (!urls.length) { return; }

    const { compactGroupTitles } = useWorkspaceStore.getState();
    const isCompact = compact !== undefined ? compact : compactGroupTitles;
    const fullTitle = title.trim() || getAutoGroupName();
    const chromeTitle = isCompact ? (fullTitle[0] || "") : fullTitle;

    const groupId = await openAsTabGroup(urls, chromeTitle, color);

    const currentTitles = { ...get().fullTitles, [groupId]: fullTitle };
    idbPut("tab-group-titles", { groupId, title: fullTitle });

    // Reload after tabs open
    const [tabs, groups] = await Promise.all([
      getCurrentWindowTabs(),
      getCurrentWindowGroups(),
    ]);
    set({ openTabs: tabs, tabGroups: groups, fullTitles: currentTitles });
  },

  openCollectionAsGroup: async (collectionId, title, color, compact) => {
    const { bookmarks: bookmarksMap } = useBookmarksStore.getState();
    const urls = Array.from(bookmarksMap.values())
      .filter((b) => b.collectionId === collectionId)
      .map((b) => b.url);
    await get().openUrlsAsGroup(urls, title, color, compact);
  },
```

Create `lib/bookmark-clipboard.ts`:

```ts
import type { Bookmark } from "@/lib/types";

/** One URL per line. */
export function formatLinkList(bookmarks: readonly Pick<Bookmark, "url">[]): string {
  return bookmarks.map((bookmark) => bookmark.url).join("\n");
}

function escapeLinkText(title: string): string {
  return title.replace(/[\\[\]]/g, (character) => `\\${character}`).replace(/\r\n|\r|\n/g, " ");
}

function escapeLinkTarget(url: string): string {
  return url.replace(/[ ()]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** One `- [title](url)` line per bookmark, safe to paste into Markdown. */
export function formatMarkdownLinkList(bookmarks: readonly Pick<Bookmark, "title" | "url">[]): string {
  return bookmarks
    .map((bookmark) => `- [${escapeLinkText(bookmark.title)}](${escapeLinkTarget(bookmark.url)})`)
    .join("\n");
}
```

Create `components/dashboard/bulk-actions/open-tabs-confirm-dialog.tsx`:

```tsx
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslation } from "@/hooks/use-translation";

interface OpenTabsConfirmDialogProps {
  count: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function OpenTabsConfirmDialog({ count, open, onOpenChange, onConfirm }: OpenTabsConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("bulkActions_confirmOpenTitle", [String(count)])}</DialogTitle>
          <DialogDescription>{t("bulkActions_confirmOpenDesc")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("settings_cancel")}
          </Button>
          <Button type="button" size="sm" onClick={onConfirm}>
            {t("bulkActions_confirmOpen")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Add Open and ⋯ to the bar**

In `components/dashboard/bulk-actions/index.tsx`, extend the imports:

```tsx
import { Archive, ChevronDown, ExternalLink, FolderInput, Heart, MoreHorizontal, Trash2, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { supportsTabGroups } from "@/lib/browser/capabilities";
import { formatLinkList, formatMarkdownLinkList } from "@/lib/bookmark-clipboard";
import { openUrlsInBackground } from "@/lib/chrome/tabs";
import { useTabsStore } from "@/store/tabs-store";
import { OpenTabsConfirmDialog } from "./open-tabs-confirm-dialog";
```

Add above the component:

```ts
/** Opening more tabs than this asks first. */
const OPEN_CONFIRM_THRESHOLD = 10;

type OpenMode = "tabs" | "group";
```

Inside `BulkActionBar`, add after the store selectors:

```ts
  const openUrlsAsGroup = useTabsStore((s) => s.openUrlsAsGroup);
  const [pendingOpen, setPendingOpen] = React.useState<OpenMode | null>(null);
```

and after `handleSelectAll`:

```ts
  /** The selected bookmarks in the view's display order. */
  const selectedInViewOrder = () =>
    activeBookmarks((orders?.current.viewOrder ?? []).filter((id) => selectedIds.has(id)), bookmarks);

  /** The shared collection's name when the bookmarks share one, otherwise the active workspace's. */
  const groupTitleFor = (ordered: readonly Bookmark[]): string => {
    const state = useWorkspaceStore.getState();
    const collectionIds = new Set(ordered.map((bookmark) => bookmark.collectionId));
    const [onlyCollectionId] = collectionIds;
    const shared = collectionIds.size === 1
      ? state.collections.find((collection) => collection.id === onlyCollectionId)
      : undefined;
    return shared?.name ?? state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId)?.name ?? "";
  };

  const openSelection = async (mode: OpenMode) => {
    const ordered = selectedInViewOrder();
    const urls = ordered.map((bookmark) => bookmark.url);
    try {
      if (mode === "group") {
        await openUrlsAsGroup(urls, groupTitleFor(ordered), "grey");
      } else {
        await openUrlsInBackground(urls);
      }
    } catch {
      showNotice({ tone: "error", message: t("bulkActions_openFailed") });
    }
  };

  const handleOpen = (mode: OpenMode) => {
    if (selected.length > OPEN_CONFIRM_THRESHOLD) {
      setPendingOpen(mode);
      return;
    }
    void openSelection(mode);
  };

  const handleConfirmOpen = () => {
    const mode = pendingOpen;
    setPendingOpen(null);
    if (mode) {
      void openSelection(mode);
    }
  };

  const handleCopy = async (format: "plain" | "markdown") => {
    const ordered = selectedInViewOrder();
    const text = format === "markdown" ? formatMarkdownLinkList(ordered) : formatLinkList(ordered);
    try {
      await navigator.clipboard.writeText(text);
      showNotice({
        tone: "success",
        message: ordered.length === 1 ? t("bulkActions_copiedOne") : t("bulkActions_copiedOther", [String(ordered.length)]),
      });
    } catch {
      showNotice({ tone: "error", message: t("bulkActions_copyFailed") });
    }
  };
```

In the toolbar, give the Archive button `className="hidden sm:inline-flex"`, and add the Open menu after Delete and the ⋯ menu after it (both before Select all):

```tsx
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="hidden sm:inline-flex">
                  <ExternalLink className="size-4" />
                  {t("bulkActions_open")}
                  <ChevronDown className="size-3.5 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center">
                <DropdownMenuItem onSelect={() => handleOpen("tabs")}>{t("bulkActions_openAll")}</DropdownMenuItem>
                {supportsTabGroups() && (
                  <DropdownMenuItem onSelect={() => handleOpen("group")}>{t("bulkActions_openAsGroup")}</DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={t("bulkActions_more")}>
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void handleCopy("plain")}>{t("bulkActions_copyLinks")}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void handleCopy("markdown")}>{t("bulkActions_copyMarkdown")}</DropdownMenuItem>
                {/* Below the sm breakpoint, Open and Archive live here. */}
                <DropdownMenuSeparator className="sm:hidden" />
                <DropdownMenuItem className="sm:hidden" onSelect={() => handleOpen("tabs")}>{t("bulkActions_openAll")}</DropdownMenuItem>
                {supportsTabGroups() && (
                  <DropdownMenuItem className="sm:hidden" onSelect={() => handleOpen("group")}>{t("bulkActions_openAsGroup")}</DropdownMenuItem>
                )}
                <DropdownMenuItem className="sm:hidden" onSelect={handleArchive}>{t("bulkActions_archive")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
```

Render the confirmation inside the selection branch, after the toolbar's closing `</div>` and before the sticky wrapper closes:

```tsx
          <OpenTabsConfirmDialog
            count={selected.length}
            open={pendingOpen !== null}
            onOpenChange={(open) => {
              if (!open) {
                setPendingOpen(null);
              }
            }}
            onConfirm={handleConfirmOpen}
          />
```

Add to `public/_locales/en/messages.json`:

```json
  "bulkActions_open": {
    "message": "Open"
  },
  "bulkActions_openAll": {
    "message": "Open all in new tabs"
  },
  "bulkActions_openAsGroup": {
    "message": "Open as a tab group"
  },
  "bulkActions_more": {
    "message": "More actions"
  },
  "bulkActions_copyLinks": {
    "message": "Copy links"
  },
  "bulkActions_copyMarkdown": {
    "message": "Copy as Markdown list"
  },
  "bulkActions_copiedOne": {
    "message": "Copied 1 link"
  },
  "bulkActions_copiedOther": {
    "message": "Copied $1 links",
    "placeholders": {
      "1": {
        "content": "$1"
      }
    }
  },
  "bulkActions_copyFailed": {
    "message": "Couldn't copy to the clipboard"
  },
  "bulkActions_openFailed": {
    "message": "Couldn't open the tabs"
  },
  "bulkActions_confirmOpenTitle": {
    "message": "Open $1 tabs?",
    "placeholders": {
      "1": {
        "content": "$1"
      }
    }
  },
  "bulkActions_confirmOpenDesc": {
    "message": "Each selected bookmark opens in a new background tab."
  },
  "bulkActions_confirmOpen": {
    "message": "Open tabs"
  },
```

Add to `public/_locales/zh_CN/messages.json`:

```json
  "bulkActions_open": {
    "message": "打开"
  },
  "bulkActions_openAll": {
    "message": "在新标签页中全部打开"
  },
  "bulkActions_openAsGroup": {
    "message": "作为标签组打开"
  },
  "bulkActions_more": {
    "message": "更多操作"
  },
  "bulkActions_copyLinks": {
    "message": "复制链接"
  },
  "bulkActions_copyMarkdown": {
    "message": "复制为 Markdown 列表"
  },
  "bulkActions_copiedOne": {
    "message": "已复制 1 个链接"
  },
  "bulkActions_copiedOther": {
    "message": "已复制 $1 个链接",
    "placeholders": {
      "1": {
        "content": "$1"
      }
    }
  },
  "bulkActions_copyFailed": {
    "message": "无法复制到剪贴板"
  },
  "bulkActions_openFailed": {
    "message": "无法打开标签页"
  },
  "bulkActions_confirmOpenTitle": {
    "message": "打开 $1 个标签页？",
    "placeholders": {
      "1": {
        "content": "$1"
      }
    }
  },
  "bulkActions_confirmOpenDesc": {
    "message": "每个选中的书签都会在新的后台标签页中打开。"
  },
  "bulkActions_confirmOpen": {
    "message": "打开标签页"
  },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/bookmark-clipboard.test.ts test/chrome-tabs-background.test.ts test/bulk-open-copy.test.tsx test/bulk-action-bar.test.tsx test/bulk-tags-menu.test.tsx test/tabs-store-cross-window-search.test.js && bun run compile`
Expected: all pass; `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add lib/chrome/tabs.ts store/tabs-store.ts lib/bookmark-clipboard.ts components/dashboard/bulk-actions public/_locales test/bookmark-clipboard.test.ts test/chrome-tabs-background.test.ts test/bulk-open-copy.test.tsx
git commit -m "feat(bookmarks): open and copy a selection

Open all in background tabs or as a tab group named after the
shared collection, asking first above ten tabs; copy the links as
plain lines or a Markdown list. Below the sm breakpoint, Open and
Archive move into the overflow menu.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Part 5: One bookmark form and notes

### Task 13: Bookmark form and dialog

**Files:**
- Create: `components/ui/textarea.tsx`
- Create: `lib/bookmark-dialog-events.ts`
- Create: `components/dashboard/shared/bookmark-form.tsx`
- Create: `components/dashboard/shared/bookmark-dialog.tsx`
- Modify: `test/helpers/dom-environment.ts` (`typeInto` accepts a textarea)
- Modify: both `messages.json`
- Test: `test/bookmark-form.test.tsx`, `test/bookmark-form-duplicates.test.tsx` (new)

**Interfaces:**
- Consumes: `CollectionPicker`, `TagPicker` (Task 9); `MAX_BOOKMARK_NOTES_LENGTH`, `bookmarkCreatedAtTime` (Task 3); `BookmarkBatchPatch` (Task 3); `findVisibleDuplicates`, `DuplicateNotice`, `revealBookmark` (A).
- Produces: `OPEN_BOOKMARK_DIALOG_EVENT = "tabslate-open-bookmark"`; `BookmarkFormFocus = "tags" | "notes"`; `OpenBookmarkDialogRequest { bookmarkId?: string; focus?: BookmarkFormFocus }`; `openBookmarkDialog(request?)`; `readOpenBookmarkDialogRequest(event: Event): OpenBookmarkDialogRequest`; `BookmarkForm` (props `bookmark?`, `focus?`, `onDone`, `onCancel`); `normalizeBookmarkUrl(input: string): string | null`; `BookmarkDialog` (no props; listens for the event itself); `Textarea`; `typeInto(input: HTMLInputElement | HTMLTextAreaElement, value)`.

- [ ] **Step 1: Write the failing tests**

In `test/helpers/dom-environment.ts`, replace `typeInto`:

```ts
export function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  act(() => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
```

Create `test/bookmark-form.test.tsx`:

```tsx
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import type { OpenBookmarkDialogRequest } from "@/lib/bookmark-dialog-events";
import type { Bookmark } from "@/lib/types";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import {
  click,
  getBySelector,
  getByText,
  installAppModules,
  pressKey,
  queryByText,
  render,
  setupDom,
  submitForm,
  teardownDom,
  typeInto,
  type AppModules,
  type RenderResult,
} from "./helpers/dom-environment";
import { bookmarkMap, countsByCollection, makeBookmark, makeCollection, makeTag, makeWorkspace } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
let app: AppModules;
let BookmarkDialog: typeof import("@/components/dashboard/shared/bookmark-dialog").BookmarkDialog;
let openBookmarkDialog: typeof import("@/lib/bookmark-dialog-events").openBookmarkDialog;
let usePlanStore: typeof import("@/store/plan-store").usePlanStore;
let view: RenderResult | null = null;

const saved = makeBookmark("saved", {
  title: "Saved",
  url: "https://example.com/saved",
  description: "Desc",
  notes: "Old note",
  collectionId: "reading",
  tags: ["frontend"],
  createdAt: "2026-01-02T00:00:00.000Z",
  updatedAt: Date.parse("2026-03-04T00:00:00.000Z"),
});

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ usePlanStore } = await import("@/store/plan-store"));
  ({ openBookmarkDialog } = await import("@/lib/bookmark-dialog-events"));
  ({ BookmarkDialog } = await importFresh<typeof import("@/components/dashboard/shared/bookmark-dialog")>("components/dashboard/shared/bookmark-dialog.tsx"));
});
afterAll(async () => {
  view?.unmount();
  replacer.restore();
  await teardownDom();
});

function renderDialog(path = "/"): void {
  view?.unmount();
  view = render(app, createElement(MemoryRouter, { initialEntries: [path] }, createElement(BookmarkDialog)));
}

function seed(bookmarks: Bookmark[]): void {
  app.useBookmarksStore.setState({ bookmarks: bookmarkMap(bookmarks), countsByCollection: countsByCollection(bookmarks) });
}

beforeEach(() => {
  usePlanStore.setState({ limits: null, usage: null, fetchedAt: Date.now(), quotaAlert: null });
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home")],
    collections: [
      makeCollection("reading", "home", { name: "Reading", isDefault: true }),
      makeCollection("projects", "home", { name: "Projects", position: 1 }),
    ],
    tags: [makeTag("frontend", "Frontend")],
  });
  app.useBookmarksStore.setState({
    selectedCollection: "all",
    archivedBookmarks: [],
    trashedBookmarks: [],
    _archivedLoaded: true,
    _trashedLoaded: true,
    highlightedBookmarkId: null,
  });
  seed([saved]);
  renderDialog();
});

function open(request?: OpenBookmarkDialogRequest): void {
  act(() => {
    openBookmarkDialog(request);
  });
}
function field<T extends Element = HTMLInputElement>(name: string): T {
  return getBySelector<T>(`[role="dialog"] [name="${name}"]`);
}
async function save(): Promise<void> {
  await submitForm(getBySelector<HTMLFormElement>('[role="dialog"] form'));
}
const dialogOpen = () => document.querySelector('[role="dialog"]') !== null;
const added = () => [...app.useBookmarksStore.getState().bookmarks.values()].find((bookmark) => bookmark.id !== "saved");
const tagField = () => getBySelector<HTMLInputElement>('[role="dialog"] [role="combobox"]');

function fillRequired(title: string, url: string): void {
  typeInto(field("title"), title);
  typeInto(field("url"), url);
}

describe("adding a bookmark", () => {
  test("requires a title and a valid address", async () => {
    open();
    await save();
    expect(getByText("bookmarkForm_errorTitle")).toBeTruthy();
    expect(getByText("bookmarkForm_errorUrl")).toBeTruthy();

    fillRequired("Page", "not a url");
    await save();
    expect(getByText("bookmarkForm_errorUrl")).toBeTruthy();
    expect(app.useBookmarksStore.getState().bookmarks.size).toBe(1);
  });

  test("an address without a scheme gets https://, and the bookmark keeps its notes and tags", async () => {
    open();
    fillRequired("Docs", "example.com/docs");
    typeInto(field<HTMLTextAreaElement>("notes"), "  Read before Friday  ");
    typeInto(tagField(), "front");
    pressKey(tagField(), "Enter");
    await save();

    const bookmark = added();
    expect(bookmark?.url).toBe("https://example.com/docs");
    expect(bookmark?.notes).toBe("Read before Friday");
    expect(bookmark?.tags).toEqual(["frontend"]);
    expect(bookmark?.collectionId).toBe("reading");
    expect(dialogOpen()).toBe(false);
  });

  test("an address with a scheme is kept as typed", async () => {
    open();
    fillRequired("Files", "ftp://files.example.com/a");
    await save();
    expect(added()?.url).toBe("ftp://files.example.com/a");
  });

  test("starts in the collection being viewed, otherwise in the default collection", async () => {
    act(() => {
      app.useBookmarksStore.setState({ selectedCollection: "projects" });
    });
    open();
    fillRequired("In projects", "example.com/p");
    await save();
    expect(added()?.collectionId).toBe("projects");

    seed([saved]);
    renderDialog("/favorites");
    open();
    fillRequired("From favorites", "example.com/f");
    await save();
    expect(added()?.collectionId).toBe("reading");
  });

  test("Cmd or Ctrl+Enter saves from the notes field, and plain Enter does not", () => {
    open();
    fillRequired("Docs", "example.com/docs");
    pressKey(field<HTMLTextAreaElement>("notes"), "Enter");
    expect(dialogOpen()).toBe(true);

    pressKey(field<HTMLTextAreaElement>("notes"), "Enter", { ctrlKey: true });
    expect(added()?.title).toBe("Docs");
    expect(dialogOpen()).toBe(false);
  });

  test("notes take up to 10,000 characters and show a counter above 9,000", () => {
    open();
    const notes = field<HTMLTextAreaElement>("notes");
    expect(notes.getAttribute("maxlength")).toBe("10000");
    typeInto(notes, "x".repeat(9_000));
    expect(queryByText("bookmarkForm_notesCounter[9000,10000]")).toBeNull();
    typeInto(notes, "x".repeat(9_001));
    expect(getByText("bookmarkForm_notesCounter[9001,10000]")).toBeTruthy();
  });

  test("a save the bookmark quota blocks keeps the form open", async () => {
    usePlanStore.setState({
      limits: { max_bookmarks: 1, max_collections: 100, max_tags: 100, max_workspaces: 10, max_saved_groups: 100, trash_grace_days: 30 },
      usage: { bookmarks: 1, collections: 2, tags: 1, workspaces: 1, saved_groups: 0 },
      fetchedAt: Date.now(),
    });
    open();
    fillRequired("Over quota", "example.com/over");
    await save();
    expect(added()).toBeUndefined();
    expect(dialogOpen()).toBe(true);
    expect(field("title").value).toBe("Over quota");
  });
});

describe("editing a bookmark", () => {
  test("starts from the bookmark and closes without writing when nothing changed", async () => {
    open({ bookmarkId: "saved" });
    expect(field("title").value).toBe("Saved");
    expect(field<HTMLTextAreaElement>("notes").value).toBe("Old note");
    const before = app.useBookmarksStore.getState().bookmarks.get("saved");

    await save();

    expect(dialogOpen()).toBe(false);
    expect(app.useBookmarksStore.getState().bookmarks.get("saved")).toBe(before);
  });

  test("writes only the fields the user changed", async () => {
    open({ bookmarkId: "saved" });
    act(() => {
      seed([{ ...saved, description: "Changed on another device" }]);
    });
    typeInto(field("title"), "Renamed");
    await save();

    const stored = app.useBookmarksStore.getState().bookmarks.get("saved");
    expect(stored?.title).toBe("Renamed");
    expect(stored?.description).toBe("Changed on another device");
    expect(stored?.notes).toBe("Old note");
    expect(stored?.updatedAt).not.toBe(saved.updatedAt);
  });

  test("a bookmark archived on another device meanwhile is not saved", async () => {
    open({ bookmarkId: "saved" });
    act(() => {
      app.useBookmarksStore.getState().archiveBookmark("saved");
    });
    typeInto(field("title"), "Renamed");
    await save();

    expect(getByText("bookmarkForm_changedElsewhere")).toBeTruthy();
    expect(app.useBookmarksStore.getState().archivedBookmarks.find((bookmark) => bookmark.id === "saved")?.title).toBe("Saved");
    expect(dialogOpen()).toBe(true);
  });

  test("a request for a bookmark that is no longer active does not open the dialog", () => {
    open({ bookmarkId: "missing" });
    expect(dialogOpen()).toBe(false);
  });

  test("a focus request puts the cursor in the notes or the tags field", () => {
    open({ bookmarkId: "saved", focus: "notes" });
    const notes = field<HTMLTextAreaElement>("notes");
    expect(document.activeElement).toBe(notes);
    expect(notes.selectionStart).toBe(notes.value.length);
    click(getByText("settings_cancel"));

    open({ bookmarkId: "saved", focus: "tags" });
    expect(document.activeElement).toBe(tagField());
  });

  test("shows when the bookmark was added and last updated", () => {
    const format = new Intl.DateTimeFormat("en", { dateStyle: "medium" });
    open({ bookmarkId: "saved" });
    const text = getBySelector('[role="dialog"]').textContent ?? "";
    expect(text).toContain(`bookmarkForm_added[${format.format(Date.parse("2026-01-02T00:00:00.000Z"))}]`);
    expect(text).toContain(`bookmarkForm_updated[${format.format(Date.parse("2026-03-04T00:00:00.000Z"))}]`);
  });

  test("leaves out the update time for a bookmark saved before edit times existed", () => {
    seed([makeBookmark("legacy", { collectionId: "reading" })]);
    open({ bookmarkId: "legacy" });
    const text = getBySelector('[role="dialog"]').textContent ?? "";
    expect(text).toContain("bookmarkForm_added[");
    expect(text).not.toContain("bookmarkForm_updated[");
  });

  test("an uncategorized bookmark shows Uncategorized until another collection is picked", () => {
    seed([makeBookmark("loose", { collectionId: "" })]);
    open({ bookmarkId: "loose" });
    expect(getByText("bookmarkForm_uncategorized")).toBeTruthy();
  });
});
```

Create `test/bookmark-form-duplicates.test.tsx` (it replaces `test/add-bookmark-duplicates.test.tsx`, which Task 14 deletes with the old dialog):

```tsx
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import type { OpenBookmarkDialogRequest } from "@/lib/bookmark-dialog-events";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import {
  click,
  getBySelector,
  getByText,
  installAppModules,
  render,
  setupDom,
  submitForm,
  teardownDom,
  typeInto,
  wait,
  type AppModules,
  type RenderResult,
} from "./helpers/dom-environment";
import { bookmarkMap, countsByCollection, makeBookmark, makeCollection, makeWorkspace } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
let app: AppModules;
let BookmarkDialog: typeof import("@/components/dashboard/shared/bookmark-dialog").BookmarkDialog;
let openBookmarkDialog: typeof import("@/lib/bookmark-dialog-events").openBookmarkDialog;
let view: RenderResult | null = null;

const saved = makeBookmark("saved", { collectionId: "projects", url: "https://example.com/post" });
const twin = makeBookmark("twin", { collectionId: "reading", url: "https://example.com/twin" });

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ openBookmarkDialog } = await import("@/lib/bookmark-dialog-events"));
  ({ BookmarkDialog } = await importFresh<typeof import("@/components/dashboard/shared/bookmark-dialog")>("components/dashboard/shared/bookmark-dialog.tsx"));
});
afterAll(async () => {
  view?.unmount();
  act(() => app.useBookmarksStore.getState().setHighlightedBookmarkId(null));
  replacer.restore();
  await teardownDom();
});

beforeEach(() => {
  view?.unmount();
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home", { name: "Home" }), makeWorkspace("work", { name: "Work" })],
    collections: [
      makeCollection("reading", "home", { name: "Reading", isDefault: true }),
      makeCollection("projects", "work", { name: "Projects", isDefault: true }),
    ],
    tags: [],
  });
  app.useBookmarksStore.setState({
    bookmarks: bookmarkMap([saved, twin]),
    countsByCollection: countsByCollection([saved, twin]),
    highlightedBookmarkId: null,
  });
  view = render(app, createElement(MemoryRouter, null, createElement(BookmarkDialog)));
  open();
});

function open(request?: OpenBookmarkDialogRequest): void {
  act(() => {
    openBookmarkDialog(request);
  });
}
const urlField = () => getBySelector<HTMLInputElement>('[role="dialog"] [name="url"]');
const notice = () => document.querySelector('[data-slot="duplicate-notice"]');
const dialogOpen = () => document.querySelector('[role="dialog"]') !== null;

describe("duplicate notice in the bookmark form", () => {
  test("warns about a saved variant of the address and shows where it lives", async () => {
    typeInto(urlField(), "http://www.example.com/post?utm_source=feed");
    await wait(350);
    expect(notice()?.textContent).toContain("duplicateNotice_location[Projects,Work]");
  });

  test("open existing bookmark closes the dialog and reveals the bookmark", async () => {
    typeInto(urlField(), "example.com/post");
    await wait(350);
    click(getByText("duplicateNotice_openExisting"));

    expect(dialogOpen()).toBe(false);
    expect(app.useWorkspaceStore.getState().activeWorkspaceId).toBe("work");
    expect(app.useBookmarksStore.getState().highlightedBookmarkId).toBe("saved");
  });

  test("reopening uses the latest saved bookmarks and locations", async () => {
    click(getByText("settings_cancel"));
    const latest = makeBookmark("latest", { collectionId: "projects", url: "https://example.com/latest" });
    act(() => {
      app.useBookmarksStore.setState({ bookmarks: bookmarkMap([latest]) });
      app.useWorkspaceStore.setState({
        workspaces: [makeWorkspace("home", { name: "Home" }), makeWorkspace("work", { name: "Updated work" })],
        collections: [
          makeCollection("reading", "home", { name: "Reading", isDefault: true }),
          makeCollection("projects", "work", { name: "Updated projects", isDefault: true }),
        ],
      });
    });
    open();
    expect(urlField().value).toBe("");
    typeInto(urlField(), "example.com/latest");
    await wait(350);
    expect(notice()?.textContent).toContain("duplicateNotice_location[Updated projects,Updated work]");
  });

  test("stays quiet for an address that is not saved", async () => {
    typeInto(urlField(), "https://example.com/other");
    await wait(350);
    expect(notice()).toBeNull();
    expect(dialogOpen()).toBe(true);
  });

  test("a duplicate notice never blocks saving", async () => {
    typeInto(getBySelector<HTMLInputElement>('[role="dialog"] [name="title"]'), "Again");
    typeInto(urlField(), "example.com/post");
    await wait(350);
    expect(notice()).not.toBeNull();
    await submitForm(getBySelector<HTMLFormElement>('[role="dialog"] form'));
    expect(app.useBookmarksStore.getState().bookmarks.size).toBe(3);
  });

  test("edit mode checks only after the address changes and never matches the bookmark itself", async () => {
    click(getByText("settings_cancel"));
    open({ bookmarkId: "saved" });
    await wait(350);
    expect(notice()).toBeNull();

    typeInto(urlField(), "https://example.com/twin");
    await wait(350);
    expect(notice()?.textContent).toContain("duplicateNotice_location[Reading,Home]");

    typeInto(urlField(), "https://example.com/post");
    await wait(350);
    expect(notice()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/bookmark-form.test.tsx test/bookmark-form-duplicates.test.tsx`
Expected: FAIL — `Cannot find module '@/lib/bookmark-dialog-events'`.

- [ ] **Step 3: Add the textarea and the open event**

Create `components/ui/textarea.tsx`:

```tsx
import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 flex field-sizing-content min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
```

Create `lib/bookmark-dialog-events.ts`:

```ts
/** The window event that opens the bookmark dialog mounted by WorkspaceRail. */
export const OPEN_BOOKMARK_DIALOG_EVENT = "tabslate-open-bookmark";

export type BookmarkFormFocus = "tags" | "notes";

export interface OpenBookmarkDialogRequest {
  /** The bookmark to edit; omitted to add one. */
  bookmarkId?: string;
  /** The field that gets the cursor; the title by default. */
  focus?: BookmarkFormFocus;
}

/** Opens the bookmark dialog: add mode without an ID, edit mode with one. */
export function openBookmarkDialog(request: OpenBookmarkDialogRequest = {}): void {
  window.dispatchEvent(new CustomEvent<OpenBookmarkDialogRequest>(OPEN_BOOKMARK_DIALOG_EVENT, { detail: request }));
}

function isBookmarkFormFocus(value: unknown): value is BookmarkFormFocus {
  return value === "tags" || value === "notes";
}

/** Reads a request from the event, ignoring anything malformed. */
export function readOpenBookmarkDialogRequest(event: Event): OpenBookmarkDialogRequest {
  if (!(event instanceof CustomEvent)) {
    return {};
  }
  const detail: unknown = event.detail;
  if (typeof detail !== "object" || detail === null) {
    return {};
  }
  const bookmarkId: unknown = Reflect.get(detail, "bookmarkId");
  const focus: unknown = Reflect.get(detail, "focus");
  return {
    bookmarkId: typeof bookmarkId === "string" ? bookmarkId : undefined,
    focus: isBookmarkFormFocus(focus) ? focus : undefined,
  };
}
```

- [ ] **Step 4: Implement the form**

Create `components/dashboard/shared/bookmark-form.tsx`:

```tsx
import * as React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AlertCircle, ChevronDown } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CollectionPicker } from "@/components/dashboard/shared/collection-picker";
import { DuplicateNotice } from "@/components/dashboard/shared/duplicate-notice";
import { TagPicker } from "@/components/dashboard/shared/tag-picker";
import { useTranslation } from "@/hooks/use-translation";
import type { BookmarkFormFocus } from "@/lib/bookmark-dialog-events";
import { bookmarkCreatedAtTime, MAX_BOOKMARK_NOTES_LENGTH } from "@/lib/bookmark-utils";
import { findVisibleDuplicates } from "@/lib/duplicate-lookup";
import { revealBookmark } from "@/lib/reveal-bookmark";
import type { Bookmark, BookmarkBatchPatch } from "@/lib/types";
import { getActiveWorkspaceCollections, resolveActiveWorkspaceCollectionTarget } from "@/lib/workspace-visibility";
import { bookmarksAsArray, useBookmarksStore } from "@/store/bookmarks-store";
import { resolveAcceptLanguage } from "@/store/i18n-store";
import { useWorkspaceStore } from "@/store/workspace-store";

/** The notes field shows a counter above this length. */
const NOTES_COUNTER_FROM = 9_000;

interface BookmarkFormProps {
  /** The bookmark to edit; omitted to add one. */
  bookmark?: Bookmark;
  /** The field that gets the cursor; the title by default. */
  focus?: BookmarkFormFocus;
  /** Called after a save, and when an edit changed nothing. */
  onDone: () => void;
  onCancel: () => void;
}

interface FieldErrors {
  title?: string;
  url?: string;
}

/** An address without "://" gets https://, and the result must parse. Null when it does not. */
export function normalizeBookmarkUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  try {
    new URL(candidate);
    return candidate;
  } catch {
    return null;
  }
}

/** A text field changed when the user edited it and its saved value differs from the stored one. */
function changedText(input: string, saved: string, stored: string): string | undefined {
  return input !== stored && saved !== stored ? saved : undefined;
}

function sameTags(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((tagId, index) => tagId === right[index]);
}

/**
 * The bookmark form body, without a container, so a dialog or a panel can
 * host it. Adding resolves the target collection again before saving; editing
 * writes only the fields the user changed, compared with the bookmark as the
 * form opened it, so fields changed on another device meanwhile survive.
 */
export function BookmarkForm({ bookmark, focus, onDone, onCancel }: BookmarkFormProps) {
  const { t, language } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const idPrefix = React.useId();
  const addBookmark = useBookmarksStore((s) => s.addBookmark);
  const updateBookmark = useBookmarksStore((s) => s.updateBookmark);
  const selectedCollection = useBookmarksStore((s) => s.selectedCollection);
  const storedBookmarks = useBookmarksStore((s) => s.bookmarks);
  const collections = useWorkspaceStore((s) => s.collections);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  const activeCollections = React.useMemo(
    () => getActiveWorkspaceCollections(activeWorkspaceId, workspaces, collections),
    [activeWorkspaceId, workspaces, collections],
  );
  const defaultCollectionId = activeCollections.find((collection) => collection.isDefault)?.id ?? activeCollections[0]?.id ?? "";

  const [title, setTitle] = React.useState(bookmark?.title ?? "");
  const [url, setUrl] = React.useState(bookmark?.url ?? "");
  const [description, setDescription] = React.useState(bookmark?.description ?? "");
  const [notes, setNotes] = React.useState(bookmark?.notes ?? "");
  const [collectionId, setCollectionId] = React.useState(() => {
    if (bookmark) {
      return bookmark.collectionId;
    }
    const viewingCollection = pathname === "/" && activeCollections.some((collection) => collection.id === selectedCollection);
    return viewingCollection ? selectedCollection : defaultCollectionId;
  });
  const [tags, setTags] = React.useState<string[]>(() => [...(bookmark?.tags ?? [])]);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [targetUnavailable, setTargetUnavailable] = React.useState(false);
  const [changedElsewhere, setChangedElsewhere] = React.useState(false);
  const [duplicateUrl, setDuplicateUrl] = React.useState("");
  const notesRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    if (focus !== "notes") {
      return;
    }
    const field = notesRef.current;
    field?.focus();
    field?.setSelectionRange(field.value.length, field.value.length);
  }, [focus]);

  React.useEffect(() => {
    const timer = setTimeout(() => setDuplicateUrl(url.trim()), 300);
    return () => clearTimeout(timer);
  }, [url]);

  const duplicateMatches = React.useMemo(() => {
    // Edit mode checks only once the address changes, and never matches the bookmark itself.
    if (!duplicateUrl || duplicateUrl === bookmark?.url) {
      return [];
    }
    const candidate = normalizeBookmarkUrl(duplicateUrl);
    if (!candidate) {
      return [];
    }
    return findVisibleDuplicates(
      candidate,
      { bookmarks: bookmarksAsArray(storedBookmarks), collections, workspaces },
      "loose",
    ).filter((match) => match.bookmark.id !== bookmark?.id);
  }, [duplicateUrl, bookmark, storedBookmarks, collections, workspaces]);

  const dateFormat = React.useMemo(
    () => new Intl.DateTimeFormat(resolveAcceptLanguage(language), { dateStyle: "medium" }),
    [language],
  );

  const collectionLabel = collectionId === ""
    ? t("bookmarkForm_uncategorized")
    : activeCollections.find((collection) => collection.id === collectionId)?.name ?? t("bookmarkForm_chooseCollection");

  const handleOpenExisting = (bookmarkId: string) => {
    onCancel();
    navigate("/");
    revealBookmark(bookmarkId);
  };

  const handleCollectionSelect = (id: string) => {
    setCollectionId(id);
    setTargetUnavailable(false);
  };

  const saveNew = (savedTitle: string, savedUrl: string) => {
    const state = useWorkspaceStore.getState();
    const target = resolveActiveWorkspaceCollectionTarget(
      collectionId || defaultCollectionId,
      state.activeWorkspaceId,
      state.workspaces,
      state.collections,
    );
    if (!target) {
      const refreshed = getActiveWorkspaceCollections(state.activeWorkspaceId, state.workspaces, state.collections);
      setCollectionId(refreshed.find((collection) => collection.isDefault)?.id ?? refreshed[0]?.id ?? "");
      setTargetUnavailable(true);
      return;
    }
    const added = addBookmark({
      title: savedTitle,
      url: savedUrl,
      description: description.trim(),
      notes: notes.trim(),
      favicon: "",
      collectionId: target.id,
      tags,
      seq: 0,
    });
    // An empty ID means the quota blocked the save; the quota alert says so, and the input stays.
    if (added.id) {
      onDone();
    }
  };

  const saveEdit = (original: Bookmark, savedTitle: string, savedUrl: string) => {
    if (!useBookmarksStore.getState().bookmarks.has(original.id)) {
      setChangedElsewhere(true);
      return;
    }
    const patch: BookmarkBatchPatch = {};
    const changedTitle = changedText(title, savedTitle, original.title);
    if (changedTitle !== undefined) { patch.title = changedTitle; }
    if (savedUrl !== original.url) { patch.url = savedUrl; }
    const changedDescription = changedText(description, description.trim(), original.description);
    if (changedDescription !== undefined) { patch.description = changedDescription; }
    const changedNotes = changedText(notes, notes.trim(), original.notes ?? "");
    if (changedNotes !== undefined) { patch.notes = changedNotes; }
    if (collectionId !== original.collectionId) { patch.collectionId = collectionId; }
    if (!sameTags(tags, original.tags)) { patch.tags = tags; }

    if (Object.keys(patch).length === 0) {
      onDone();
      return;
    }
    if (patch.collectionId !== undefined) {
      const state = useWorkspaceStore.getState();
      if (!resolveActiveWorkspaceCollectionTarget(patch.collectionId, state.activeWorkspaceId, state.workspaces, state.collections)) {
        setCollectionId(original.collectionId);
        setTargetUnavailable(true);
        return;
      }
    }
    updateBookmark(original.id, patch);
    onDone();
  };

  const handleSave = () => {
    const savedTitle = title.trim();
    // An untouched address is kept as it is, even if it predates the URL rule.
    const savedUrl = bookmark && url === bookmark.url ? bookmark.url : normalizeBookmarkUrl(url);
    setErrors({
      title: savedTitle ? undefined : t("bookmarkForm_errorTitle"),
      url: savedUrl ? undefined : t("bookmarkForm_errorUrl"),
    });
    if (!savedTitle || !savedUrl) {
      return;
    }
    if (bookmark) {
      saveEdit(bookmark, savedTitle, savedUrl);
    } else {
      saveNew(savedTitle, savedUrl);
    }
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    handleSave();
  };

  // Cmd/Ctrl+Enter saves from any field; plain Enter in the notes adds a line.
  const handleKeyDown = (event: React.KeyboardEvent<HTMLFormElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      handleSave();
    }
  };

  return (
    <form className="space-y-4" onSubmit={handleSubmit} onKeyDown={handleKeyDown} noValidate>
      {changedElsewhere && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{t("bookmarkForm_changedElsewhere")}</AlertDescription>
        </Alert>
      )}
      {targetUnavailable && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{t("workspaceVisibility_targetUnavailable")}</AlertDescription>
        </Alert>
      )}
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-title`}>{t("bookmarkForm_titleLabel")}</FieldLabel>
        <Input
          id={`${idPrefix}-title`}
          name="title"
          value={title}
          placeholder={t("bookmarkForm_titlePlaceholder")}
          autoFocus={focus === undefined}
          aria-invalid={errors.title !== undefined}
          aria-describedby={errors.title ? `${idPrefix}-title-error` : undefined}
          onChange={(event) => {
            setTitle(event.target.value);
            setErrors((current) => ({ ...current, title: undefined }));
          }}
        />
        {errors.title && (
          <p id={`${idPrefix}-title-error`} role="alert" className="text-xs text-destructive">{errors.title}</p>
        )}
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-url`}>{t("bookmarkForm_urlLabel")}</FieldLabel>
        <Input
          id={`${idPrefix}-url`}
          name="url"
          value={url}
          placeholder={t("bookmarkForm_urlPlaceholder")}
          aria-invalid={errors.url !== undefined}
          aria-describedby={errors.url ? `${idPrefix}-url-error` : undefined}
          onChange={(event) => {
            setUrl(event.target.value);
            setErrors((current) => ({ ...current, url: undefined }));
          }}
        />
        {errors.url && (
          <p id={`${idPrefix}-url-error`} role="alert" className="text-xs text-destructive">{errors.url}</p>
        )}
      </Field>
      <DuplicateNotice matches={duplicateMatches} onOpenExisting={handleOpenExisting} />
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-description`}>{t("bookmarkForm_descriptionLabel")}</FieldLabel>
        <Input
          id={`${idPrefix}-description`}
          name="description"
          value={description}
          placeholder={t("bookmarkForm_descriptionPlaceholder")}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-notes`}>{t("bookmarkForm_notesLabel")}</FieldLabel>
        <Textarea
          ref={notesRef}
          id={`${idPrefix}-notes`}
          name="notes"
          value={notes}
          maxLength={MAX_BOOKMARK_NOTES_LENGTH}
          placeholder={t("bookmarkForm_notesPlaceholder")}
          className="max-h-60"
          onChange={(event) => setNotes(event.target.value)}
        />
        {notes.length > NOTES_COUNTER_FROM && (
          <p className="text-right text-xs text-muted-foreground">
            {t("bookmarkForm_notesCounter", [String(notes.length), String(MAX_BOOKMARK_NOTES_LENGTH)])}
          </p>
        )}
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-collection`}>{t("bookmarkForm_collectionLabel")}</FieldLabel>
        <CollectionPicker selectedId={collectionId} onSelect={handleCollectionSelect}>
          <Button id={`${idPrefix}-collection`} type="button" variant="outline" className="w-full justify-between font-normal">
            <span className="truncate">{collectionLabel}</span>
            <ChevronDown className="size-4 shrink-0 opacity-50" />
          </Button>
        </CollectionPicker>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-tags`}>{t("bookmarkForm_tagsLabel")}</FieldLabel>
        <TagPicker value={tags} onChange={setTags} inputId={`${idPrefix}-tags`} autoFocus={focus === "tags"} />
      </Field>
      {bookmark && (
        <p className="text-xs text-muted-foreground">
          {t("bookmarkForm_added", [dateFormat.format(bookmarkCreatedAtTime(bookmark.createdAt))])}
          {bookmark.updatedAt !== undefined && ` · ${t("bookmarkForm_updated", [dateFormat.format(bookmark.updatedAt)])}`}
        </p>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          {t("settings_cancel")}
        </Button>
        <Button type="submit" size="sm">
          {t(bookmark ? "bookmarkForm_save" : "bookmarkForm_add")}
        </Button>
      </div>
    </form>
  );
}
```

- [ ] **Step 5: Implement the dialog**

Create `components/dashboard/shared/bookmark-dialog.tsx`:

```tsx
import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BookmarkForm } from "@/components/dashboard/shared/bookmark-form";
import { useTranslation } from "@/hooks/use-translation";
import {
  OPEN_BOOKMARK_DIALOG_EVENT,
  readOpenBookmarkDialogRequest,
  type BookmarkFormFocus,
} from "@/lib/bookmark-dialog-events";
import type { Bookmark } from "@/lib/types";
import { useBookmarksStore } from "@/store/bookmarks-store";

interface DialogRequest {
  /** Remounts the form for every request, so it always starts from that request. */
  key: number;
  bookmark?: Bookmark;
  focus?: BookmarkFormFocus;
}

/**
 * The one add/edit bookmark dialog. WorkspaceRail mounts it once, and anything
 * opens it with openBookmarkDialog(). An edit request for a bookmark that is
 * no longer active is ignored.
 */
export function BookmarkDialog() {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [request, setRequest] = React.useState<DialogRequest | null>(null);
  const nextKey = React.useRef(0);

  React.useEffect(() => {
    const handleOpenRequest = (event: Event) => {
      const { bookmarkId, focus } = readOpenBookmarkDialogRequest(event);
      const bookmark = bookmarkId === undefined ? undefined : useBookmarksStore.getState().bookmarks.get(bookmarkId);
      if (bookmarkId !== undefined && !bookmark) {
        return;
      }
      nextKey.current += 1;
      setRequest({ key: nextKey.current, bookmark, focus });
      setOpen(true);
    };
    window.addEventListener(OPEN_BOOKMARK_DIALOG_EVENT, handleOpenRequest);
    return () => window.removeEventListener(OPEN_BOOKMARK_DIALOG_EVENT, handleOpenRequest);
  }, []);

  const handleClose = React.useCallback(() => setOpen(false), []);
  const editing = request?.bookmark !== undefined;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t(editing ? "bookmarkForm_editTitle" : "bookmarkForm_addTitle")}</DialogTitle>
          <DialogDescription>{t(editing ? "bookmarkForm_editDesc" : "bookmarkForm_addDesc")}</DialogDescription>
        </DialogHeader>
        {request && (
          <BookmarkForm
            key={request.key}
            bookmark={request.bookmark}
            focus={request.focus}
            onDone={handleClose}
            onCancel={handleClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
```

Add to `public/_locales/en/messages.json`:

```json
  "bookmarkForm_addTitle": {
    "message": "Add bookmark"
  },
  "bookmarkForm_addDesc": {
    "message": "Save a page with notes, a collection and tags."
  },
  "bookmarkForm_editTitle": {
    "message": "Edit bookmark"
  },
  "bookmarkForm_editDesc": {
    "message": "Change the bookmark's details, notes, collection or tags."
  },
  "bookmarkForm_titleLabel": {
    "message": "Title"
  },
  "bookmarkForm_titlePlaceholder": {
    "message": "My Website"
  },
  "bookmarkForm_urlLabel": {
    "message": "URL"
  },
  "bookmarkForm_urlPlaceholder": {
    "message": "https://example.com"
  },
  "bookmarkForm_descriptionLabel": {
    "message": "Description"
  },
  "bookmarkForm_descriptionPlaceholder": {
    "message": "Optional description..."
  },
  "bookmarkForm_notesLabel": {
    "message": "Notes"
  },
  "bookmarkForm_notesPlaceholder": {
    "message": "Why you saved it, what to remember…"
  },
  "bookmarkForm_notesCounter": {
    "message": "$1 / $2",
    "placeholders": {
      "1": {
        "content": "$1"
      },
      "2": {
        "content": "$2"
      }
    }
  },
  "bookmarkForm_collectionLabel": {
    "message": "Collection"
  },
  "bookmarkForm_chooseCollection": {
    "message": "Choose a collection"
  },
  "bookmarkForm_uncategorized": {
    "message": "Uncategorized"
  },
  "bookmarkForm_tagsLabel": {
    "message": "Tags"
  },
  "bookmarkForm_errorTitle": {
    "message": "Enter a title."
  },
  "bookmarkForm_errorUrl": {
    "message": "Enter a valid URL."
  },
  "bookmarkForm_changedElsewhere": {
    "message": "This bookmark was changed on another device. Close this dialog to see its current state."
  },
  "bookmarkForm_added": {
    "message": "Added $1",
    "placeholders": {
      "1": {
        "content": "$1"
      }
    }
  },
  "bookmarkForm_updated": {
    "message": "Updated $1",
    "placeholders": {
      "1": {
        "content": "$1"
      }
    }
  },
  "bookmarkForm_add": {
    "message": "Add bookmark"
  },
  "bookmarkForm_save": {
    "message": "Save changes"
  },
```

Add to `public/_locales/zh_CN/messages.json`:

```json
  "bookmarkForm_addTitle": {
    "message": "添加书签"
  },
  "bookmarkForm_addDesc": {
    "message": "保存网页，并附上备注、收藏集和标签。"
  },
  "bookmarkForm_editTitle": {
    "message": "编辑书签"
  },
  "bookmarkForm_editDesc": {
    "message": "修改书签的信息、备注、收藏集或标签。"
  },
  "bookmarkForm_titleLabel": {
    "message": "标题"
  },
  "bookmarkForm_titlePlaceholder": {
    "message": "我的网站"
  },
  "bookmarkForm_urlLabel": {
    "message": "网址"
  },
  "bookmarkForm_urlPlaceholder": {
    "message": "https://example.com"
  },
  "bookmarkForm_descriptionLabel": {
    "message": "描述"
  },
  "bookmarkForm_descriptionPlaceholder": {
    "message": "选填描述…"
  },
  "bookmarkForm_notesLabel": {
    "message": "备注"
  },
  "bookmarkForm_notesPlaceholder": {
    "message": "为什么保存它、需要记住什么…"
  },
  "bookmarkForm_notesCounter": {
    "message": "$1 / $2",
    "placeholders": {
      "1": {
        "content": "$1"
      },
      "2": {
        "content": "$2"
      }
    }
  },
  "bookmarkForm_collectionLabel": {
    "message": "收藏集"
  },
  "bookmarkForm_chooseCollection": {
    "message": "选择收藏集"
  },
  "bookmarkForm_uncategorized": {
    "message": "未分类"
  },
  "bookmarkForm_tagsLabel": {
    "message": "标签"
  },
  "bookmarkForm_errorTitle": {
    "message": "请输入标题。"
  },
  "bookmarkForm_errorUrl": {
    "message": "请输入有效的网址。"
  },
  "bookmarkForm_changedElsewhere": {
    "message": "此书签已在其他设备上更改。关闭对话框即可查看它的当前状态。"
  },
  "bookmarkForm_added": {
    "message": "添加于 $1",
    "placeholders": {
      "1": {
        "content": "$1"
      }
    }
  },
  "bookmarkForm_updated": {
    "message": "更新于 $1",
    "placeholders": {
      "1": {
        "content": "$1"
      }
    }
  },
  "bookmarkForm_add": {
    "message": "添加书签"
  },
  "bookmarkForm_save": {
    "message": "保存更改"
  },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test test/bookmark-form.test.tsx test/bookmark-form-duplicates.test.tsx test/collection-picker.test.tsx test/tag-picker.test.tsx && bun run compile`
Expected: all pass; `tsc` exits 0.

- [ ] **Step 7: Commit**

```bash
git add components/ui/textarea.tsx lib/bookmark-dialog-events.ts components/dashboard/shared/bookmark-form.tsx components/dashboard/shared/bookmark-dialog.tsx test/helpers/dom-environment.ts public/_locales test/bookmark-form.test.tsx test/bookmark-form-duplicates.test.tsx
git commit -m "feat(bookmarks): one form to add and edit bookmarks

The form covers title, URL, description, notes, collection and tags,
saves with Cmd/Ctrl+Enter, and in edit mode writes only the fields
the user changed. A window event opens its dialog.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 14: Open the form everywhere and remove the old dialogs

**Files:**
- Modify: `components/dashboard/workspace-rail.tsx` (mount `BookmarkDialog`)
- Modify: `components/dashboard/header.tsx` (Add bookmark opens the form)
- Modify: `components/dashboard/shared/bookmark-menu-items.tsx` (Edit and Add tags always present)
- Modify: `components/dashboard/bookmark-card.tsx` (drop `onEdit`/`onAddTags`; menu items open the form)
- Modify: `components/dashboard/content.tsx` (drop the editing state, props and dialogs)
- Delete: `components/dashboard/add-bookmark-dialog.tsx`, `components/dashboard/shared/edit-bookmark-dialog.tsx`, `components/dashboard/shared/bookmark-tags-dialog.tsx`, `test/add-bookmark-duplicates.test.tsx`
- Modify: both `messages.json` (remove the deleted dialogs' keys)
- Test: `test/bookmark-card-menu.test.tsx`; `test/favorites-bookmark-form.test.tsx` (new)

**Interfaces:**
- Consumes: `openBookmarkDialog`, `BookmarkDialog` (Task 13).
- Produces: `BookmarkCard` props are `bookmark`, `variant?`, `isHighlighted?`, `dragHandleProps?`; `BookmarkMenuItems` requires `onEdit` and `onAddTags`.

- [ ] **Step 1: Write the failing tests**

In `test/bookmark-card-menu.test.tsx`:

1. Add the import:

```ts
import {
  OPEN_BOOKMARK_DIALOG_EVENT,
  readOpenBookmarkDialogRequest,
  type OpenBookmarkDialogRequest,
} from "@/lib/bookmark-dialog-events";
```

2. Delete the `handleEdit` and `handleAddTags` mocks, their `mockClear()` calls, and `MENU_ITEMS_WITHOUT_EDITING`.
3. In the per-variant `beforeEach`, render the card without handlers:

```ts
    beforeEach(() => {
      view?.rerender(createElement(BookmarkCard, { bookmark: article, variant }));
    });
```

4. Replace the test "Edit and Add tags hand the bookmark to their handlers" with:

```ts
    test("Edit and Add tags open the bookmark form", async () => {
      const requests: OpenBookmarkDialogRequest[] = [];
      const handleOpenRequest = (event: Event) => {
        requests.push(readOpenBookmarkDialogRequest(event));
      };
      window.addEventListener(OPEN_BOOKMARK_DIALOG_EVENT, handleOpenRequest);
      try {
        await act(async () => {
          rightClick(getBySelector('[data-bookmark-id="b1"]'));
        });
        click(getByText("bookmarkCard_edit"));
        await act(async () => {
          openDropdown(getBySelector('[aria-label="bookmarkCard_moreActions"]'));
        });
        click(getByText("bookmarkCard_addTags"));
      } finally {
        window.removeEventListener(OPEN_BOOKMARK_DIALOG_EVENT, handleOpenRequest);
      }
      expect(requests).toEqual([{ bookmarkId: "b1" }, { bookmarkId: "b1", focus: "tags" }]);
    });
```

5. Delete the test "without edit and tag handlers, as on Favorites, the menus leave out Edit and Add tags".

Create `test/favorites-bookmark-form.test.tsx`:

```tsx
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { click, getBySelector, getByText, installAppModules, openDropdown, render, rightClick, setupDom, teardownDom, type AppModules, type RenderResult } from "./helpers/dom-environment";
import { bookmarkMap, countsByCollection, makeBookmark, makeCollection, makeTag, makeWorkspace } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
let app: AppModules;
let FavoritesContent: typeof import("@/components/dashboard/favorites-content").FavoritesContent;
let BookmarkDialog: typeof import("@/components/dashboard/shared/bookmark-dialog").BookmarkDialog;
let view: RenderResult | null = null;

const favorite = makeBookmark("fav", { title: "Favorite page", collectionId: "reading", isFavorite: true });

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ FavoritesContent } = await importFresh<typeof import("@/components/dashboard/favorites-content")>("components/dashboard/favorites-content.tsx"));
  ({ BookmarkDialog } = await importFresh<typeof import("@/components/dashboard/shared/bookmark-dialog")>("components/dashboard/shared/bookmark-dialog.tsx"));
});
afterAll(async () => {
  view?.unmount();
  replacer.restore();
  await teardownDom();
});
beforeEach(() => {
  view?.unmount();
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home")],
    collections: [makeCollection("reading", "home", { isDefault: true })],
    tags: [makeTag("frontend", "Frontend")],
  });
  app.useBookmarksStore.setState({ bookmarks: bookmarkMap([favorite]), countsByCollection: countsByCollection([favorite]), selectedTags: [] });
  view = render(app, createElement(
    MemoryRouter,
    { initialEntries: ["/favorites"] },
    createElement(FavoritesContent),
    createElement(BookmarkDialog),
  ));
});

describe("editing from the Favorites page", () => {
  test("Edit opens the form for the bookmark", async () => {
    await act(async () => {
      rightClick(getBySelector('[data-bookmark-id="fav"]'));
    });
    click(getByText("bookmarkCard_edit"));
    expect(getBySelector<HTMLInputElement>('[role="dialog"] [name="title"]').value).toBe("Favorite page");
  });

  test("Add tags opens the form at the tag field", async () => {
    await act(async () => {
      openDropdown(getBySelector('[aria-label="bookmarkCard_moreActions"]'));
    });
    click(getByText("bookmarkCard_addTags"));
    expect(document.activeElement).toBe(getBySelector('[role="dialog"] [role="combobox"]'));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/bookmark-card-menu.test.tsx test/favorites-bookmark-form.test.tsx`
Expected: FAIL — `No element with text "bookmarkCard_edit"` (Favorites passes no edit handler) and no `tabslate-open-bookmark` requests.

- [ ] **Step 3: Open the form from the menus and the header**

Replace `components/dashboard/shared/bookmark-menu-items.tsx`'s props and items:

```tsx
interface BookmarkMenuItemsProps {
  menu: MenuPrimitives;
  onOpenSmart: () => void;
  onOpenNewTab: () => void;
  onEdit: () => void;
  onAddTags: () => void;
  onArchive: () => void;
  onDelete: () => void;
}
```

```tsx
      <Item onSelect={onEdit}>
        <Pencil className="size-4" />
        {t("bookmarkCard_edit")}
      </Item>
      <Item onSelect={onAddTags}>
        <TagIcon className="size-4" />
        {t("bookmarkCard_addTags")}
      </Item>
```

In `components/dashboard/bookmark-card.tsx`:
- import `openBookmarkDialog` from `@/lib/bookmark-dialog-events`;
- remove `onEdit` and `onAddTags` from `BookmarkCardProps` and from the destructured props;
- replace the two handlers:

```ts
  const handleEdit = React.useCallback(() => openBookmarkDialog({ bookmarkId: bookmark.id }), [bookmark.id]);
  const handleAddTags = React.useCallback(
    () => openBookmarkDialog({ bookmarkId: bookmark.id, focus: "tags" }),
    [bookmark.id],
  );
```

- in `renderMenuItems`, pass `onEdit={handleEdit}` and `onAddTags={handleAddTags}`.

In `components/dashboard/content.tsx`:
- delete the `EditBookmarkDialog` and `BookmarkTagsDialog` imports;
- remove `onEdit`/`onAddTags` from `DraggableBookmarkCardProps`, from `DraggableBookmarkCard`'s parameters, and from the `BookmarkCard` it renders;
- delete the `editingBookmark` and `taggingBookmark` state;
- render `DraggableBookmarkCard` with `key`, `bookmark`, `variant` and `isHighlighted` only;
- delete the two dialogs rendered after the virtual list.

In `components/dashboard/header.tsx`:
- delete `import { useState } from "react";`, the `AddBookmarkDialog` import, the `addBookmarkOpen` state and the `<AddBookmarkDialog … />` element;
- import `openBookmarkDialog` from `@/lib/bookmark-dialog-events`;
- change the button: `onClick={() => openBookmarkDialog()}`.

In `components/dashboard/workspace-rail.tsx`, import `BookmarkDialog` from `@/components/dashboard/shared/bookmark-dialog` and render it after `<ImportDialog … />`:

```tsx
      <BookmarkDialog />
```

- [ ] **Step 4: Delete the old dialogs and their strings**

```bash
git rm components/dashboard/add-bookmark-dialog.tsx components/dashboard/shared/edit-bookmark-dialog.tsx components/dashboard/shared/bookmark-tags-dialog.tsx test/add-bookmark-duplicates.test.tsx
grep -rn "add-bookmark-dialog\|edit-bookmark-dialog\|bookmark-tags-dialog\|AddBookmarkDialog\|EditBookmarkDialog\|BookmarkTagsDialog" components entrypoints lib hooks store test
```

Expected: the `grep` prints nothing.

Remove the keys only those dialogs used:

```bash
python3 - <<'PY'
import json
import subprocess

keys = [
    "addBookmark_btnSubmit", "addBookmark_desc", "addBookmark_fieldCollection", "addBookmark_fieldDesc",
    "addBookmark_fieldTags", "addBookmark_fieldTitle", "addBookmark_fieldUrl", "addBookmark_placeholderDesc",
    "addBookmark_placeholderTitle", "addBookmark_placeholderUrl", "addBookmark_selectCollection", "addBookmark_title",
    "bookmarkTagsDialog_cancel", "bookmarkTagsDialog_createTag", "bookmarkTagsDialog_desc", "bookmarkTagsDialog_noTags",
    "bookmarkTagsDialog_save", "bookmarkTagsDialog_title",
    "editBookmarkDialog_cancel", "editBookmarkDialog_desc", "editBookmarkDialog_descField", "editBookmarkDialog_save",
    "editBookmarkDialog_title", "editBookmarkDialog_titleField", "editBookmarkDialog_urlField",
]
for key in keys:
    used = subprocess.run(
        ["grep", "-rlF", f'"{key}"', "components", "entrypoints", "lib", "hooks", "store", "test"],
        capture_output=True, text=True,
    ).stdout.strip()
    if used:
        raise SystemExit(f"{key} is still used in: {used}")
for path in ["public/_locales/en/messages.json", "public/_locales/zh_CN/messages.json"]:
    with open(path, encoding="utf-8") as handle:
        messages = json.load(handle)
    for key in keys:
        messages.pop(key, None)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(messages, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
PY
git diff -U0 public/_locales | grep '^+' | grep -v '^+++'
```

Expected: the last command prints nothing, or only a trailing-newline change; the diff otherwise only removes the 25 keys. If the rewrite reformatted anything else, restore the files with `git checkout public/_locales` and delete the 25 keys by hand instead.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/bookmark-card-menu.test.tsx test/favorites-bookmark-form.test.tsx test/bookmarks-header-subscription.test.tsx test/library-visible-filters.test.tsx test/library-selection.test.tsx test/bookmark-form.test.tsx && bun run compile`
Expected: all pass; `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add -A components/dashboard test/bookmark-card-menu.test.tsx test/favorites-bookmark-form.test.tsx public/_locales
git commit -m "refactor(bookmarks): open the one form from every entry point

The header, the card menus and the right-click menus open the
bookmark dialog, which WorkspaceRail mounts once. Edit and Add tags
now also work on the Favorites page. The add, edit and tags dialogs
are gone.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 15: Notes on cards

**Files:**
- Create: `lib/linkify.ts`
- Create: `components/dashboard/shared/bookmark-notes-popover.tsx`
- Modify: `components/dashboard/bookmark-card.tsx`
- Modify: `lib/drag-sensors.ts` (ignore presses inside `[role="dialog"]`)
- Modify: both `messages.json`
- Test: `test/linkify.test.ts`, `test/bookmark-notes-popover.test.tsx` (new)

**Interfaces:**
- Consumes: `Popover` (Task 9), `openBookmarkDialog` (Task 13), `SelectionOrdersProvider` (Task 7).
- Produces: `LinkifySegment { kind: "text" | "link"; text: string }`, `linkifySegments(text: string): LinkifySegment[]`; `BookmarkNotesPopover` with props `bookmarkId: string`, `notes: string`.

- [ ] **Step 1: Write the failing tests**

Create `test/linkify.test.ts`:

```ts
// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import { linkifySegments } from "@/lib/linkify";

describe("linkifySegments", () => {
  test("turns http and https addresses into links and leaves sentence punctuation outside", () => {
    expect(linkifySegments("Read https://example.com/docs. Then (see http://a.example/x?y=1)!")).toEqual([
      { kind: "text", text: "Read " },
      { kind: "link", text: "https://example.com/docs" },
      { kind: "text", text: ". Then (see " },
      { kind: "link", text: "http://a.example/x?y=1" },
      { kind: "text", text: ")!" },
    ]);
  });

  test("keeps text without links, and other schemes, as text", () => {
    expect(linkifySegments("javascript:alert(1) and ftp://files.example")).toEqual([
      { kind: "text", text: "javascript:alert(1) and ftp://files.example" },
    ]);
  });

  test("returns nothing for an empty note", () => {
    expect(linkifySegments("")).toEqual([]);
  });
});
```

Create `test/bookmark-notes-popover.test.tsx`:

```tsx
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement, type PointerEvent as ReactPointerEvent } from "react";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { click, getBySelector, getByText, installAppModules, render, setupDom, teardownDom, type AppModules, type RenderResult } from "./helpers/dom-environment";
import { bookmarkMap, countsByCollection, makeBookmark, makeCollection, makeWorkspace } from "./helpers/library-fixtures";
import {
  OPEN_BOOKMARK_DIALOG_EVENT,
  readOpenBookmarkDialogRequest,
  type OpenBookmarkDialogRequest,
} from "@/lib/bookmark-dialog-events";

const replacer = createModuleReplacer();
const smartOpenUrl = mock(async () => {});
let app: AppModules;
let BookmarkCard: typeof import("@/components/dashboard/bookmark-card").BookmarkCard;
let SelectionOrdersProvider: typeof import("@/components/dashboard/shared/selection-orders").SelectionOrdersProvider;
let SmartPointerSensor: typeof import("@/lib/drag-sensors").SmartPointerSensor;
let useSelectionStore: typeof import("@/store/selection-store").useSelectionStore;
let view: RenderResult | null = null;

const noted = makeBookmark("noted", {
  title: "Noted",
  collectionId: "reading",
  notes: "Line one <b>not bold</b>\nRead https://example.com/docs.",
});
const plain = makeBookmark("plain", { title: "Plain", collectionId: "reading" });

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  const realTabs = await importFresh<typeof import("@/lib/chrome/tabs")>("lib/chrome/tabs.ts");
  await replacer.replace("@/lib/chrome/tabs", { ...realTabs, smartOpenUrl });
  ({ useSelectionStore } = await import("@/store/selection-store"));
  ({ SelectionOrdersProvider } = await import("@/components/dashboard/shared/selection-orders"));
  ({ SmartPointerSensor } = await import("@/lib/drag-sensors"));
  ({ BookmarkCard } = await importFresh<typeof import("@/components/dashboard/bookmark-card")>("components/dashboard/bookmark-card.tsx"));
});
afterAll(async () => {
  view?.unmount();
  replacer.restore();
  await teardownDom();
});

function renderCards(): void {
  view?.unmount();
  view = render(app, createElement(SelectionOrdersProvider, {
    viewOrder: ["noted", "plain"],
    onScreenOrder: ["noted", "plain"],
    children: [
      createElement(BookmarkCard, { key: "noted", bookmark: noted, variant: "list" }),
      createElement(BookmarkCard, { key: "plain", bookmark: plain, variant: "grid" }),
    ],
  }));
}

beforeEach(() => {
  smartOpenUrl.mockClear();
  app.useWorkspaceStore.setState({ activeWorkspaceId: "home", workspaces: [makeWorkspace("home")], collections: [makeCollection("reading", "home")], tags: [] });
  app.useBookmarksStore.setState({ bookmarks: bookmarkMap([noted, plain]), countsByCollection: countsByCollection([noted, plain]) });
  act(() => {
    useSelectionStore.getState().clear();
  });
  renderCards();
});

const notesButton = () => getBySelector('[data-bookmark-id="noted"] [aria-label="bookmarkNotes_show"]');
const popover = () => getBySelector('[data-slot="popover-content"]');

describe("bookmark notes on cards", () => {
  test("only a card with notes shows the notes button", () => {
    expect(notesButton()).toBeTruthy();
    expect(document.querySelector('[data-bookmark-id="plain"] [aria-label="bookmarkNotes_show"]')).toBeNull();
  });

  test("the popover shows the whole note as text, with links that open in a new tab", () => {
    click(notesButton());
    expect(popover().textContent).toContain("Line one <b>not bold</b>");
    expect(popover().querySelector("b")).toBeNull();
    const link = getBySelector<HTMLAnchorElement>('[data-slot="popover-content"] a');
    expect(link.textContent).toBe("https://example.com/docs");
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  test("clicks on the button and inside the popover neither open the bookmark nor change the selection", () => {
    act(() => {
      useSelectionStore.getState().toggle("plain");
    });
    click(notesButton());
    click(getByText("bookmarkNotes_heading"));
    expect(smartOpenUrl).not.toHaveBeenCalled();
    expect([...useSelectionStore.getState().selectedIds]).toEqual(["plain"]);
  });

  test("Edit note opens the form with the cursor in the notes", () => {
    const requests: OpenBookmarkDialogRequest[] = [];
    const handleOpenRequest = (event: Event) => {
      requests.push(readOpenBookmarkDialogRequest(event));
    };
    window.addEventListener(OPEN_BOOKMARK_DIALOG_EVENT, handleOpenRequest);
    try {
      click(notesButton());
      click(getByText("bookmarkNotes_edit"));
    } finally {
      window.removeEventListener(OPEN_BOOKMARK_DIALOG_EVENT, handleOpenRequest);
    }
    expect(requests).toEqual([{ bookmarkId: "noted", focus: "notes" }]);
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
  });

  test("a press inside the popover never starts a card drag", () => {
    // Card menus and popovers render in portals, but React still bubbles their presses to the card's drag wrapper.
    const presses: ReactPointerEvent[] = [];
    view?.unmount();
    view = render(app, createElement(
      "div",
      { onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => { presses.push(event); } },
      createElement(BookmarkCard, { bookmark: noted, variant: "list" }),
    ));
    click(notesButton());
    act(() => {
      popover().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerType: "mouse" }));
    });
    const [press] = presses;
    if (!press) {
      throw new Error("the press did not reach the card's parent");
    }
    const [activator] = SmartPointerSensor.activators;
    expect(activator.handler(press, {})).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/linkify.test.ts test/bookmark-notes-popover.test.tsx`
Expected: FAIL — `Cannot find module '@/lib/linkify'` and no notes button.

- [ ] **Step 3: Implement linkify, the popover and the sensor filter**

Create `lib/linkify.ts`:

```ts
export interface LinkifySegment {
  kind: "text" | "link";
  text: string;
}

const LINK_PATTERN = /https?:\/\/[^\s<>"']+/gi;
/** Punctuation that ends a sentence right after a link stays outside the link. */
const TRAILING_PUNCTUATION = /[.,;:!?)]+$/;
const WEB_LINK = /^https?:\/\/./i;

/**
 * Splits note text into plain text and http(s) links. Callers render the
 * segments as React text and elements, never as HTML.
 */
export function linkifySegments(text: string): LinkifySegment[] {
  const segments: LinkifySegment[] = [];
  let textStart = 0;
  for (const match of text.matchAll(LINK_PATTERN)) {
    const start = match.index ?? 0;
    const link = match[0].replace(TRAILING_PUNCTUATION, "");
    if (!WEB_LINK.test(link)) {
      continue;
    }
    if (start > textStart) {
      segments.push({ kind: "text", text: text.slice(textStart, start) });
    }
    segments.push({ kind: "link", text: link });
    textStart = start + link.length;
  }
  if (textStart < text.length) {
    segments.push({ kind: "text", text: text.slice(textStart) });
  }
  return segments;
}
```

Create `components/dashboard/shared/bookmark-notes-popover.tsx`:

```tsx
import * as React from "react";
import { StickyNote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useTranslation } from "@/hooks/use-translation";
import { openBookmarkDialog } from "@/lib/bookmark-dialog-events";
import { linkifySegments } from "@/lib/linkify";

interface BookmarkNotesPopoverProps {
  bookmarkId: string;
  notes: string;
}

/**
 * A card's notes button and the popover with the whole note. Clicks inside
 * stop at the popover, so they neither open the bookmark nor change the
 * selection; right-clicks keep the browser's menu for links.
 */
export function BookmarkNotesPopover({ bookmarkId, notes }: BookmarkNotesPopoverProps) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const editingRef = React.useRef(false);
  const segments = React.useMemo(() => linkifySegments(notes), [notes]);

  const handleStopPropagation = (event: React.SyntheticEvent) => {
    event.stopPropagation();
  };

  const handleEditNote = () => {
    editingRef.current = true;
    setOpen(false);
    openBookmarkDialog({ bookmarkId, focus: "notes" });
  };

  // Focus returns to the button when the popover closes, except when the form takes it.
  const handleCloseAutoFocus = (event: Event) => {
    if (editingRef.current) {
      editingRef.current = false;
      event.preventDefault();
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="shrink-0"
          aria-label={t("bookmarkNotes_show")}
          onClick={handleStopPropagation}
        >
          <StickyNote className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 p-3"
        onClick={handleStopPropagation}
        onContextMenu={handleStopPropagation}
        onCloseAutoFocus={handleCloseAutoFocus}
      >
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t("bookmarkNotes_heading")}</p>
        <div className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-sm">
          {segments.map((segment, index) => segment.kind === "link" ? (
            <a
              key={index}
              href={segment.text}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all text-primary underline underline-offset-2"
            >
              {segment.text}
            </a>
          ) : (
            <React.Fragment key={index}>{segment.text}</React.Fragment>
          ))}
        </div>
        <div className="mt-3 flex justify-end">
          <Button type="button" variant="outline" size="xs" onClick={handleEditNote}>
            {t("bookmarkNotes_edit")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
```

In `components/dashboard/bookmark-card.tsx`, import the popover:

```ts
import { BookmarkNotesPopover } from "@/components/dashboard/shared/bookmark-notes-popover";
```

compute after `bookmarkTags`:

```ts
  const notes = bookmark.notes ?? "";
  const hasNotes = notes.trim() !== "";
```

and render it in both action areas. List variant, first child of the actions `div` (before the heart button):

```tsx
              {hasNotes && <BookmarkNotesPopover bookmarkId={bookmark.id} notes={notes} />}
```

Grid variant, just before the three-dot `DropdownMenu` (it stays visible, outside the slide-in group):

```tsx
              {hasNotes && <BookmarkNotesPopover bookmarkId={bookmark.id} notes={notes} />}
```

In `lib/drag-sensors.ts`, extend the comment's last sentence and the check:

```ts
 * passed via options (e.g. `{ delay: 250, tolerance: 5 }`). A press inside an
 * open menu (`role="menu"`) or popover (`role="dialog"`) never activates.
```

```ts
        // Menus and popovers render in portals, but React still bubbles their
        // presses to the draggable they belong to; such a press never starts a drag.
        if (el?.closest?.('[role="menu"], [role="dialog"]')) {
          return false;
        }
```

Add to `public/_locales/en/messages.json`:

```json
  "bookmarkNotes_show": {
    "message": "Show notes"
  },
  "bookmarkNotes_heading": {
    "message": "Notes"
  },
  "bookmarkNotes_edit": {
    "message": "Edit note"
  },
```

Add to `public/_locales/zh_CN/messages.json`:

```json
  "bookmarkNotes_show": {
    "message": "显示备注"
  },
  "bookmarkNotes_heading": {
    "message": "备注"
  },
  "bookmarkNotes_edit": {
    "message": "编辑备注"
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/linkify.test.ts test/bookmark-notes-popover.test.tsx test/bookmark-card-menu.test.tsx test/bookmark-selection.test.tsx && bun run compile`
Expected: all pass; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add lib/linkify.ts components/dashboard/shared/bookmark-notes-popover.tsx components/dashboard/bookmark-card.tsx lib/drag-sensors.ts public/_locales test/linkify.test.ts test/bookmark-notes-popover.test.tsx
git commit -m "feat(bookmarks): show notes on cards

A card with notes gets a notes button whose popover shows the whole
note with clickable links and an Edit note shortcut. Presses inside
the popover never open the bookmark, select it or start a drag.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 16: Notes in the popup and edit time in the fallback saves

**Files:**
- Modify: `lib/storage.ts` (`BookmarkInput`, `storageService.addBookmark`)
- Modify: `entrypoints/popup/App.tsx` (note field; `bookmarkData.notes`)
- Modify: `entrypoints/background.ts` (`fullBookmark.updatedAt`)
- Test: `test/popup-save-ack.test.tsx`, `test/storage-duplicates.test.ts`, `test/context-menu-save-ack.test.tsx`

**Interfaces:**
- Consumes: `Textarea` (Task 13), `MAX_BOOKMARK_NOTES_LENGTH` (Task 3).
- Produces: `BookmarkInput.notes?: string`; bookmarks written by `storageService.addBookmark` and the background IndexedDB fallback carry `updatedAt`; the popup's `ADD_BOOKMARK` data carries `notes`.

- [ ] **Step 1: Write the failing tests**

Add to `test/popup-save-ack.test.tsx` (also import `getBySelector` and `typeInto` from the DOM helpers):

```ts
test("a note added in the popup travels with the save", async () => {
  answerSave = async () => ({ status: "saved", bookmarkId: "saved-1" });
  click(getByText("popup_addNote"));
  typeInto(getBySelector<HTMLTextAreaElement>("#popup-note"), "  Read before Friday  ");
  await save();

  const [message] = delivered;
  expect(message?.type === "ADD_BOOKMARK" ? message.data.notes : undefined).toBe("Read before Friday");
});

test("the storage fallback keeps the note", async () => {
  answerSave = async () => undefined;
  click(getByText("popup_addNote"));
  typeInto(getBySelector<HTMLTextAreaElement>("#popup-note"), "Fallback note");
  await save();

  expect(fallbackWrite.mock.calls[0]?.[0].notes).toBe("Fallback note");
});
```

In `test/storage-duplicates.test.ts`, record writes and load `storageService` too. Extend the bun import with `setSystemTime`, then:

```ts
const puts: object[] = [];
let findSavedDuplicates: typeof import("@/lib/storage").findSavedDuplicates;
let storageService: typeof import("@/lib/storage").storageService;
```

In `beforeAll`, add `idbPut` to the replacement and load both exports:

```ts
    idbPut: async (_store: string, value: object) => {
      puts.push(value);
    },
```

```ts
  ({ findSavedDuplicates, storageService } = await importFresh<typeof import("@/lib/storage")>("lib/storage.ts"));
```

and append:

```ts
describe("storageService.addBookmark", () => {
  test("writes the note and stamps the edit time", async () => {
    setSystemTime(new Date(70_000));
    try {
      const saved = await storageService.addBookmark({
        title: "Page", url: "https://example.com/new", favicon: "", collectionId: "reading", notes: "Why",
      });
      expect(saved.notes).toBe("Why");
      expect(saved.updatedAt).toBe(70_000);
      expect(puts.at(-1)).toEqual(saved);
    } finally {
      setSystemTime();
    }
  });
});
```

In `test/context-menu-save-ack.test.tsx`, record the last fallback record:

```ts
let lastFallback: object | null = null;
```

```ts
  await replacer.replace("@/lib/idb", {
    ...realIdb,
    idbPut: async (_store: string, value: object) => {
      fallbackWrites += 1;
      lastFallback = value;
    },
    idbGetAll: async () => [],
  });
```

and add to the end of the test "transport failure retains direct persistence and success feedback":

```ts
  expect(typeof Reflect.get(lastFallback ?? {}, "updatedAt")).toBe("number");
```

and to the end of the test "accepted saves acknowledge the nonempty ID before showing success":

```ts
  expect(typeof bookmark.updatedAt).toBe("number");
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/popup-save-ack.test.tsx test/storage-duplicates.test.ts test/context-menu-save-ack.test.tsx`
Expected: FAIL — `No element with text "popup_addNote"`, `saved.notes` is `undefined`, and the fallback record has no `updatedAt`. (The accepted-save assertion already passes after Task 3.)

- [ ] **Step 3: Carry notes and the edit time**

In `lib/storage.ts`:

```ts
export type BookmarkInput = {
  title: string;
  url: string;
  favicon: string;
  description?: string;
  notes?: string;
  collectionId: string;
  tags?: string[];
};
```

```ts
    const newBookmark: Bookmark = {
      id: generateId(),
      title: input.title,
      url: input.url,
      favicon: input.favicon || "",
      description: input.description ?? "",
      notes: input.notes ?? "",
      collectionId: target.id,
      tags: input.tags ?? [],
      createdAt: new Date().toISOString(),
      updatedAt: Date.now(),
      isFavorite: false,
      seq: 0,
    };
```

In `entrypoints/background.ts`:

```ts
    const fullBookmark = {
      id: generateId(),
      createdAt: new Date().toISOString(),
      isFavorite: false,
      ...bookmarkData,
      updatedAt: Date.now(),
    };
```

In `entrypoints/popup/App.tsx`, import the field and limit:

```ts
import { Textarea } from "@/components/ui/textarea";
import { MAX_BOOKMARK_NOTES_LENGTH } from "@/lib/bookmark-utils";
```

add state after `tagInput`:

```ts
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
```

send the note with the save:

```ts
      const bookmarkData: Omit<BookmarkType, "id" | "createdAt" | "isFavorite"> = {
        title: pageInfo?.ogTitle || tab.title,
        url: tab.url,
        favicon: tab.favIconUrl,
        description: pageInfo?.metaDescription || "",
        notes: note.trim(),
        collectionId: currentTargetId,
        tags: selectedTags.map((t) => t.id),
        seq: 0,
      };
```

and render the collapsed note field between the tags field and the save button:

```tsx
          {/* Note */}
          {noteOpen ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="popup-note" className="text-xs font-medium text-muted-foreground">
                {t("popup_note")}
              </label>
              <Textarea
                id="popup-note"
                value={note}
                maxLength={MAX_BOOKMARK_NOTES_LENGTH}
                autoFocus
                onChange={(e) => setNote(e.target.value)}
                className="min-h-20 max-h-40 text-sm"
              />
            </div>
          ) : (
            <Button
              type="button"
              variant="link"
              size="xs"
              className="self-start px-0"
              onClick={() => setNoteOpen(true)}
            >
              {t("popup_addNote")}
            </Button>
          )}
```

`popup_note` ("Note" / "备注") and `popup_addNote` ("Add a note..." / "添加备注…") already exist in both `messages.json` files and were unused until now.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/popup-save-ack.test.tsx test/storage-duplicates.test.ts test/context-menu-save-ack.test.tsx && bun run compile`
Expected: all pass; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add lib/storage.ts entrypoints/popup/App.tsx entrypoints/background.ts test/popup-save-ack.test.tsx test/storage-duplicates.test.ts test/context-menu-save-ack.test.tsx
git commit -m "feat(popup): add a note when saving a page

The note travels in the ADD_BOOKMARK message and in the storage
fallback. Both fallback writes, the popup's and the context menu's,
now stamp the edit time.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 17: Documentation and full verification

**Files:**
- Modify: `lib/browser/data-collection-permissions.ts` (comment only)
- Modify: `CLAUDE.md`, `ARCHITECTURE.md`

- [ ] **Step 1: Mention notes in the Firefox declaration comment**

In `lib/browser/data-collection-permissions.ts`, the comment above `FIREFOX_ACCOUNT_DATA_COLLECTION` becomes:

```ts
/**
 * Sent to the sync server only after the user signs in and grants this
 * consent: account email, name and password (personallyIdentifyingInfo,
 * authenticationInfo), bookmark titles, descriptions and notes
 * (websiteContent), and server-side bookmark search queries (searchTerms).
 */
```

- [ ] **Step 2: Update CLAUDE.md**

In 共享组件, add after the `ActiveFilterChips` bullet:

```markdown
- **BookmarkForm / BookmarkDialog** (`components/dashboard/shared/bookmark-form.tsx`, `bookmark-dialog.tsx`) — 唯一的书签新增/编辑表单（标题、网址、描述、备注、收藏集、标签）。`BookmarkDialog` 由 `WorkspaceRail` 挂载一次并自行监听 `tabslate-open-bookmark`；调用方使用 `openBookmarkDialog({ bookmarkId?, focus?: "tags" | "notes" })`（`lib/bookmark-dialog-events.ts`），不传 `bookmarkId` 为新增，传入但书签已不在活跃集合中时不打开。网址不含 `://` 时补 `https://`；编辑只写入用户改动过的字段，未改动则不写入（不更新编辑时间）；Cmd/Ctrl+Enter 保存
- **CollectionPicker / TagPicker / FilterableList** (`components/dashboard/shared/`) — 可搜索的收藏集列表（含“新建收藏集…”）、chip 式标签选择器，二者与批量 Tags 菜单共用 `FilterableList`（筛选框 + listbox，方向键导航，可选“创建”行）；标签名规则在 `lib/tag-name.ts`
- **BulkActionBar** (`components/dashboard/bulk-actions/`) — 有选中项时吸附在视图滚动容器底部的批量操作栏（移动、标签、收藏、归档、删除、打开、复制链接）；常驻挂载，使提示在选中清空后仍能显示
- **Popover / Textarea** (`components/ui/popover.tsx`、`textarea.tsx`) — 标准 shadcn 组件
```

Replace the `全局 Dialog 触发机制` bullet:

```markdown
- **全局 Dialog 触发机制**：对于跨组件调用的对话框（如 `SettingsDialog`、`ImportDialog` 和 `BookmarkDialog`），使用统一的 DOM 自定义事件（`tabslate-open-settings`、`tabslate-open-import`、`tabslate-open-bookmark`）在全局派发。`WorkspaceRail` 作为持久常驻组件挂载这些弹窗；设置与导入由它注册监听，`BookmarkDialog` 自行监听，调用方统一用 `openBookmarkDialog()`。
```

Add to 注意事项, after the `**重复检测两级规则**` bullet:

```markdown
- **多选与批量操作**（`store/selection-store.ts`、`hooks/use-selection-scope.ts`、`components/dashboard/shared/selection-orders.tsx`）：选中状态只在内存中，不持久化。`BookmarksContent` 与 `FavoritesContent` 用 `SelectionOrdersProvider` 提供视图顺序（含折叠分组）与屏幕顺序（不含折叠分组），context 值是不变的 ref，卡片只在事件处理中读取，列表变化不会重渲染所有卡片；不在 provider 内的卡片（如拖拽浮层）不可选。卡片悬停时 favicon 位置显示复选框；Shift+点击按屏幕顺序从锚点选到当前卡片，Cmd（macOS）/ Ctrl（其他平台）+点击切换；有选中项时点击卡片切换选中而不打开。`useSelectionScope` 在工作区、所选收藏集、标签、筛选、搜索变化或视图卸载时清空选择，视图顺序变化时只保留仍在视图内的书签；Esc 清空，但已被其他组件处理（`defaultPrevented`）或来自输入框的 Esc 除外。批量写入走 `updateBookmarks` / `archiveBookmarks` / `trashBookmarks`：每次一次 `set()`、一次 `idbBulkWrite`、一次 `enqueue`，只作用于活跃书签，并遵守 `_archivedLoaded` / `_trashedLoaded` 规则。
- **书签备注与编辑时间**：`Bookmark.notes`（纯文本，缺省视为 `""`，上限 `MAX_BOOKMARK_NOTES_LENGTH = 10_000`）与 `Bookmark.updatedAt`（用户最后一次改动的 Unix ms）。所有用户改动（新增含导入与两条回退写入、编辑、移动、标签、收藏、归档、删除、恢复）都写入 `updatedAt`；补推、sweep、同步确认、集合级联与合并不改变它。推送总是携带 `notes` 与 `edited_at`（无 `updatedAt` 时为 `bookmarkCreatedAtTime(createdAt)`）；`mergeFromServer` 取 `notes ?? 本地 notes ?? ""` 与 `edited_at ?? updated_at ?? 本地 updatedAt`，旧服务端不会清空本地备注；两处同步确认比较都包含这两个字段。“更新时间”与“网站”排序见 `sortBookmarks`（`lib/bookmark-utils.ts`）与 `siteSortKey`（`lib/url-match.ts`），收藏页同样遵循当前排序。
- **推送分块**（`lib/sync-recovery.ts`）：`splitSyncPushPayload` 同时按实体数（900）和字节数（`MAX_SYNC_PUSH_BYTES = 384 KB`，每个实体 JSON 的 UTF-8 长度加 1）分块，非书签实体在前；单个实体超限时独占一块。服务端对超过 512 KB 的请求返回 413 且不会重试。
```

In the Firefox data-collection bullet, change “（`authenticationInfo`、`personallyIdentifyingInfo`、`searchTerms`、`websiteContent`）” to “（`authenticationInfo`、`personallyIdentifyingInfo`、`searchTerms`、`websiteContent`——书签标题、描述与备注都属于 `websiteContent`）”.

- [ ] **Step 3: Update ARCHITECTURE.md**

- In the 目录结构 entry for `shared/`, add “书签表单与对话框、收藏集/标签选择器、FilterableList、备注 popover、选择顺序 context” to its description, and add a line under `components/dashboard/`:

```markdown
│       ├── bulk-actions/       # 批量操作栏（移动、标签、收藏、归档、删除、打开、复制）与提示
```

- In Store 职责, append to the `useBookmarksStore` row: “；批量操作 `updateBookmarks` / `archiveBookmarks` / `trashBookmarks`（一次 set、一次 `idbBulkWrite`、一次 enqueue）；每次用户改动写入 `updatedAt`”, and add a row:

```markdown
| `useSelectionStore` | 不持久化 | 当前视图的多选：`selectedIds`（每次替换新 Set）、`anchorId`；`toggle` / `selectRange` / `setMany` / `retain` / `clear`；由 `useSelectionScope` 绑定到视图 |
```

- In 同步流程 step 3, replace “大负载（>900 实体）由 `splitPayload` 自动切成多个顺序请求” with “大负载由 `splitSyncPushPayload` 按实体数（≤900）和字节数（≤384 KB）切成多个顺序请求”.
- In 冲突解决（LWW）, add: “- 书签另有 `edited_at`（客户端上报的最后编辑时间），只用于“更新时间”排序与展示，不参与 LWW”.
- In 核心数据模型, change the Bookmark line to `Bookmark[] { id, title, url, favicon, description, notes?, collectionId, tags[], createdAt, updatedAt?, isFavorite, seq, deletedAt? }`.

- [ ] **Step 4: Run the full verification**

```bash
python3 -c "import json;a=json.load(open('public/_locales/en/messages.json'));b=json.load(open('public/_locales/zh_CN/messages.json'));print('missing in zh_CN:',sorted(set(a)-set(b)));print('missing in en:',sorted(set(b)-set(a)))"
bun run compile
bun test 2>&1 | tail -15
bun run build
bun run build:firefox
```

Expected: both `missing` lists are empty; `tsc` exits 0; the suite reports 0 fail; both builds succeed.

- [ ] **Step 5: Commit**

```bash
git add lib/browser/data-collection-permissions.ts CLAUDE.md ARCHITECTURE.md
git commit -m "docs: document selection, bulk actions, the bookmark form and notes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Hand the manual checks to the user**

These need real browsers and accounts, so they are reported rather than run:

1. Two signed-in browser profiles on an updated server: notes and edit times written in one appear in the other.
2. Bulk move, tag, archive and delete on several hundred bookmarks: one push per chunk, no 413, counts correct.
3. Notes created in the popup and in the form; a note with links.
4. "Date updated" order after a guest signs in (it must not mark every bookmark as just updated).
5. An extension build from before this change pushing an edit against the new server: the stored notes survive.
6. Firefox (142+): selection, Open as a tab group, and notes under the existing account-data consent.
