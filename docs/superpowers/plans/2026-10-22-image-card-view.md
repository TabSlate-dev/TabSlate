# Image Card View Implementation Plan (Sub-project C1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bookmark list view with a large card view that shows each page's `og:image` cover, read covers when pages are saved (including through `activeTab`), sync them as a new `image_url` bookmark field, and let the bookmark form fetch a page's title, description, and cover on request.

**Architecture:** Covers are page metadata: a self-contained `readPageInfo()` reads them in the content script, through `chrome.scripting.executeScript` under `activeTab`, and on HTML the bookmark form fetches. Every save path normalizes the cover with `normalizeCoverUrl()` and stores it as `Bookmark.imageUrl`, which syncs as `image_url` exactly like B's notes (absent keeps, `""` clears). The view mode `list` becomes `gallery`; `BookmarkCard` gains a gallery variant built from the small card plus a `BookmarkCover` (the image, or a generated placeholder).

**Tech Stack:** WXT MV3 extension (Chromium and Firefox 142+), React 19, Zustand 5, react-router-dom 7, Tailwind, shadcn/Radix, Bun tests with happy-dom; TabSlate-server in Go (Gin, pgx v5, PostgreSQL 17).

**Spec:** `docs/superpowers/specs/2026-10-20-image-card-view-design.md` (including the "Fetch details" supplement in section 6)

## Global Constraints

- Extension work stays on the current branch, `feat/bookmark-library-ux`, after B. Do not push, open pull requests, or use git worktrees.
- Server work goes on a new branch, `feat/bookmark-cover`, created in `/Users/lieutenant/Documents/github/TabSlate-server` from commit `e884b84` (B's notes changes; currently the tip of server `main`). TabSlate-Cloud (`/Users/lieutenant/Documents/github/TabSlate-Cloud`) is only built and tested through its local `replace` directive.
- Another session may commit in the same extension checkout. Stage files by explicit path and commit with `git commit -m "…" -- <paths>`; never `git add -A` or `git add .`.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- TypeScript: strict, no `any`, avoid `as` and `!`, curly braces on every `if`, interfaces for object shapes. `bun run compile` also type-checks the test files.
- Zustand: one selector per field, never derive arrays inside selectors, and call `syncEngine?.enqueue()` outside `set()` updaters.
- Every new user-visible string uses `t()` with a `[component]_[description]` key in both `public/_locales/en/messages.json` and `public/_locales/zh_CN/messages.json`.
- The popup and the background never import any store.
- Constants: `MAX_BOOKMARK_IMAGE_URL_LENGTH = 2048` (client, UTF-16 code units of the normalized href) and `MaxBookmarkImageURLLength = 2048` (server, runes).
- Covers: fixed 1.91:1 aspect ratio, `object-fit: cover`, `loading="lazy"`, `decoding="async"`, `referrerPolicy="no-referrer"`, `alt=""`, `draggable={false}`; failed cover URLs are remembered for the page session.
- Fetch details: `credentials: "omit"`, a 10-second timeout, at most 2 MB of body, only `text/html` and `application/xhtml+xml`, parsed with `DOMParser` (no page scripts), and site access requested inside the click handler before any `await`.
- `activeTab` is added to the permissions of both the Chromium and the Firefox builds.

## Notes on the Spec

1. The small card shows its URL under the title, not a description. The large card keeps the small card's content exactly (header row, URL line, tags) below the cover; only the title wraps to two lines.
2. `readPageInfo` takes two optional parameters, `doc = document` and `pageUrl = location.href`. The content script and `executeScript` call it without arguments, and `fetchPageMetadata` passes a parsed document and the response URL, so all three share one reader. `executeScript` passes no `args`, so the defaults apply in the page.
3. A context-menu save of a link (`info.linkUrl`) never takes the current page's cover, because the link points to another page.
4. `BookmarkDragData.variant` becomes `BookmarkViewMode` and the drag data carries `imageUrl`, so dragging a large card shows its cover.
5. `components/ui/bookmark-card-ad.tsx` has its own unrelated `list` variant and is unused; leave it alone.
6. The header's two view buttons have no accessible labels today; this plan adds labels and `aria-pressed`.
7. `readPageInfo` trims meta values and falls back from an empty `og:description` to `meta[name="description"]`; the old handler kept an empty `og:description`.
8. Existing tests that use the removed `list` view switch to `grid` (or to `gallery` where they test switching views).
9. The spec calls the store-side confirmation comparison `entityMatchesBookmark`; in the code it is `bookmarkMatchesSyncEntity`.
10. `requestPageInfo` fills fields an answer leaves out with `""`, so the context-menu save falls back from an empty URL or favicon with `||` instead of `??`.
11. `fetchPageMetadata` also honors a charset declared only in a `<meta>` tag (common on older Chinese sites), which the spec does not mention.
12. The form's thumbnail shows the cover that will be saved, so in edit mode it shows the existing cover until the address changes.

## File Structure

TabSlate-server (Task 1):
- Modify `db/schema.pg.sql` — the `image_url` column.
- Modify `internal/model/model.go` — `MaxBookmarkImageURLLength`, `ValidBookmarkImageURL`, `Bookmark.ImageURL`, `BookmarkRequest.ImageURL`.
- Modify `internal/model/model_test.go` — `TestValidBookmarkImageURL`.
- Modify `internal/handler/sync.go` — push validation, upsert, pull.
- Modify `internal/handler/bookmarks.go` — REST list, create, update.
- Create `internal/handler/bookmark_image_url_test.go`.
- Modify `CLAUDE.md`, `ARCHITECTURE.md`.

TabSlate extension:
- Modify `lib/types.ts`, `lib/api.ts`, `lib/bookmark-utils.ts`, `store/bookmarks-store.ts`, `lib/sync-confirmation.ts`, `lib/storage.ts` (Task 2).
- Create `lib/page-info.ts`; modify `entrypoints/content.ts` (Task 3).
- Modify `wxt.config.ts`, `entrypoints/popup/App.tsx`, `entrypoints/background.ts`, `store/tabs-store.ts` (Task 4).
- Create `components/dashboard/bookmark-cover.tsx` (Task 5).
- Modify `lib/view-preferences.ts`, `components/dashboard/header.tsx`, `components/dashboard/bookmark-card.tsx`, `components/dashboard/content.tsx`, `components/dashboard/favorites-content.tsx`, `components/dashboard/tabs-dnd-provider.tsx` (Task 6).
- Create `lib/page-metadata.ts`; modify `components/dashboard/shared/bookmark-form.tsx` (Task 7).
- Modify both `messages.json` files, `lib/browser/data-collection-permissions.ts` (comment), `CLAUDE.md`, `ARCHITECTURE.md` (Tasks 5–8).
- Tests: create `test/bookmark-cover-url.test.ts`, `test/page-info.test.ts`, `test/content-page-info.test.ts`, `test/tabs-store-save-covers.test.ts`, `test/bookmark-cover.test.tsx`, `test/bookmark-card-gallery.test.tsx`, `test/page-metadata.test.ts`; extend `test/bookmark-sync-fields.test.ts`, `test/popup-save-ack.test.tsx`, `test/library-visible-filters.test.tsx`, `test/bookmark-selection.test.tsx`, `test/sync-confirmation.test.ts`, `test/storage-duplicates.test.ts`, `test/context-menu-save-ack.test.tsx`, `test/wxt-config.test.ts`, `test/view-preferences.test.ts`, `test/settings-store-view-prefs.test.ts`, `test/bookmarks-header-subscription.test.tsx`, `test/bookmark-form.test.tsx`, and update the tests that use the `list` view.

## Prerequisites

Server handler tests need PostgreSQL 17 and skip without `TEST_DATABASE_URL`. Docker runs through OrbStack; if `docker info` fails, ask the user to start OrbStack.

```bash
docker start tabslate-b-test-pg 2>/dev/null || docker run -d --name tabslate-b-test-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=tabslate_test -p 55432:5432 postgres:17
export TEST_DATABASE_URL='postgres://postgres:test@localhost:55432/tabslate_test?sslmode=disable'
```

---

### Task 1: `image_url` on the server

**Files:**
- Modify: `TabSlate-server/db/schema.pg.sql` (after the `notes`/`edited_at` lines at the end)
- Modify: `TabSlate-server/internal/model/model.go` (`MaxBookmarkNotesLength` area, `Bookmark`, `BookmarkRequest`)
- Modify: `TabSlate-server/internal/model/model_test.go`
- Modify: `TabSlate-server/internal/handler/sync.go` (bookmark push loop and upsert, pull query)
- Modify: `TabSlate-server/internal/handler/bookmarks.go` (`List`, `Create`, `Update`)
- Create: `TabSlate-server/internal/handler/bookmark_image_url_test.go`
- Modify: `TabSlate-server/CLAUDE.md`, `TabSlate-server/ARCHITECTURE.md`

**Interfaces:**
- Produces: the sync and REST JSON field `image_url` (string). Pull and REST reads always return it (`""` when the bookmark has no cover). A push or REST update without it keeps the stored value; `""` clears it; a non-empty value must be an absolute `http`/`https` URL of at most 2,048 characters, or the bookmark is rejected with `invalid_field` (sync) or 400 (REST).

- [ ] **Step 1: Create the branch**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
git switch -c feat/bookmark-cover e884b84
```

- [ ] **Step 2: Write the failing model test**

Add `"strings"` to the imports of `internal/model/model_test.go` and append:

```go
func TestValidBookmarkImageURL(t *testing.T) {
	prefix := "https://example.com/"
	atLimit := prefix + strings.Repeat("a", MaxBookmarkImageURLLength-len(prefix))
	for _, tc := range []struct {
		raw  string
		want bool
	}{
		{"https://cdn.example.com/cover.png", true},
		{"http://example.com/a.jpg?size=1200", true},
		{atLimit, true},
		{atLimit + "a", false},
		{"/relative/cover.png", false},
		{"javascript:alert(1)", false},
		{"data:image/png;base64,AAAA", false},
		{"ftp://example.com/cover.png", false},
		{"https://", false},
	} {
		if got := ValidBookmarkImageURL(tc.raw); got != tc.want {
			t.Errorf("ValidBookmarkImageURL(%q) = %v, want %v", tc.raw, got, tc.want)
		}
	}
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `go test ./internal/model/ -run TestValidBookmarkImageURL`
Expected: FAIL to compile — `undefined: MaxBookmarkImageURLLength` and `undefined: ValidBookmarkImageURL`.

- [ ] **Step 4: Add the model fields and validator**

At the top of `internal/model/model.go`, after `package model`, add:

```go
import (
	"net/url"
	"unicode/utf8"
)
```

Below `const MaxBookmarkNotesLength = 10000` add:

```go
// MaxBookmarkImageURLLength is the longest cover URL a bookmark may carry, in characters.
const MaxBookmarkImageURLLength = 2048

// ValidBookmarkImageURL reports whether a non-empty cover URL is an absolute
// http or https URL within MaxBookmarkImageURLLength.
func ValidBookmarkImageURL(raw string) bool {
	if utf8.RuneCountInString(raw) > MaxBookmarkImageURLLength {
		return false
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return false
	}
	return parsed.Scheme == "http" || parsed.Scheme == "https"
}
```

In `type Bookmark struct`, after the `EditedAt` field, add:

```go
	// ImageURL is the page's og:image URL; nil when a client did not send it,
	// and such writes keep the stored cover.
	ImageURL *string `json:"image_url,omitempty"`
```

In `type BookmarkRequest struct`, after the `Notes` field, add:

```go
	ImageURL     *string `json:"image_url"   binding:"omitempty,max=2048"`
```

- [ ] **Step 5: Run the model test**

Run: `go test ./internal/model/`
Expected: PASS.

- [ ] **Step 6: Write the failing handler tests**

Create `internal/handler/bookmark_image_url_test.go`:

```go
package handler

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/TabSlate-dev/TabSlate-server/db"
	"github.com/TabSlate-dev/TabSlate-server/internal/model"
	"github.com/TabSlate-dev/TabSlate-server/internal/pubsub"
)

func readStoredBookmarkImageURL(t *testing.T, testDB *db.DB, bookmarkID string) string {
	t.Helper()
	var imageURL string
	if err := testDB.QueryRow(t.Context(),
		`SELECT image_url FROM bookmarks WHERE id = $1`, bookmarkID,
	).Scan(&imageURL); err != nil {
		t.Fatalf("read bookmark %s image_url: %v", bookmarkID, err)
	}
	return imageURL
}

func TestSyncPushStoresBookmarkImageURL(t *testing.T) {
	testDB := openSyncTestDB(t)
	userID := insertAuthTestUser(t, testDB, authTestUserSeed{email: "sync-cover-store@example.com", password: "password123"})
	bookmark := model.Bookmark{ID: "cover-bookmark", Title: "Cover", URL: "https://cover.example.com"}

	withCover := bookmark
	withCover.ImageURL = stringPtr("https://cdn.example.com/cover.png")
	if rejected := pushNotesBookmarks(t, testDB, userID, withCover).Rejected; len(rejected) != 0 {
		t.Fatalf("rejected = %#v, want none", rejected)
	}
	if got := readStoredBookmarkImageURL(t, testDB, bookmark.ID); got != "https://cdn.example.com/cover.png" {
		t.Fatalf("image_url = %q, want the pushed cover", got)
	}

	allowNextBookmarkPush(t, testDB, bookmark.ID)
	if rejected := pushNotesBookmarks(t, testDB, userID, bookmark).Rejected; len(rejected) != 0 {
		t.Fatalf("rejected = %#v, want none", rejected)
	}
	if got := readStoredBookmarkImageURL(t, testDB, bookmark.ID); got != "https://cdn.example.com/cover.png" {
		t.Fatalf("image_url = %q, want a push without image_url to keep it", got)
	}

	allowNextBookmarkPush(t, testDB, bookmark.ID)
	cleared := bookmark
	cleared.ImageURL = stringPtr("")
	if rejected := pushNotesBookmarks(t, testDB, userID, cleared).Rejected; len(rejected) != 0 {
		t.Fatalf("rejected = %#v, want none", rejected)
	}
	if got := readStoredBookmarkImageURL(t, testDB, bookmark.ID); got != "" {
		t.Fatalf("image_url = %q, want an empty string to clear it", got)
	}
}

func TestSyncPushRejectsInvalidBookmarkImageURL(t *testing.T) {
	testDB := openSyncTestDB(t)
	userID := insertAuthTestUser(t, testDB, authTestUserSeed{email: "sync-cover-invalid@example.com", password: "password123"})
	invalid := []string{
		"/relative.png",
		"javascript:alert(1)",
		"ftp://example.com/a.png",
		"https://example.com/" + strings.Repeat("a", model.MaxBookmarkImageURLLength),
	}
	var bookmarks []model.Bookmark
	for index, raw := range invalid {
		value := raw
		bookmarks = append(bookmarks, model.Bookmark{
			ID: fmt.Sprintf("cover-invalid-%d", index), Title: "Bad", URL: "https://bad.example.com", ImageURL: &value,
		})
	}
	bookmarks = append(bookmarks, model.Bookmark{
		ID: "cover-valid", Title: "Good", URL: "https://good.example.com", ImageURL: stringPtr("https://cdn.example.com/good.png"),
	})

	response := pushNotesBookmarks(t, testDB, userID, bookmarks...)

	if len(response.Rejected) != len(invalid) {
		t.Fatalf("rejected = %#v, want the %d invalid covers", response.Rejected, len(invalid))
	}
	for _, rejection := range response.Rejected {
		if rejection.Reason != model.RejectionReasonInvalidField || rejection.Type != "bookmark" {
			t.Fatalf("rejection = %#v, want invalid_field for a bookmark", rejection)
		}
	}
	if got := readStoredBookmarkImageURL(t, testDB, "cover-valid"); got != "https://cdn.example.com/good.png" {
		t.Fatalf("image_url = %q, want the valid cover stored", got)
	}
}

func TestSyncPullReturnsBookmarkImageURL(t *testing.T) {
	testDB := openSyncTestDB(t)
	userID := insertAuthTestUser(t, testDB, authTestUserSeed{email: "sync-cover-pull@example.com", password: "password123"})
	if _, err := testDB.Exec(t.Context(), `INSERT INTO user_sync_seq (user_id, seq) VALUES ($1, 2)`, userID); err != nil {
		t.Fatalf("insert user sync sequence: %v", err)
	}
	if _, err := testDB.Exec(t.Context(), `
		INSERT INTO bookmarks (id, user_id, collection_id, title, url, favicon_url, description,
		                       position, seq, is_trashed, created_at, updated_at, image_url)
		VALUES ('pull-cover', $1, NULL, 'Cover', 'https://cover.example.com', '', '', 0, 1, 0, 1, 1, 'https://cdn.example.com/c.png'),
		       ('pull-plain', $1, NULL, 'Plain', 'https://plain.example.com', '', '', 0, 2, 0, 1, 1, DEFAULT)`,
		userID); err != nil {
		t.Fatalf("insert pull bookmarks: %v", err)
	}

	response := pullSync(t, testDB, userID, 0)

	byID := map[string]model.Bookmark{}
	for _, bookmark := range response.Entities.Bookmarks {
		byID[bookmark.ID] = bookmark
	}
	if cover := byID["pull-cover"].ImageURL; cover == nil || *cover != "https://cdn.example.com/c.png" {
		t.Fatalf("pull-cover image_url = %v, want the stored cover", cover)
	}
	if plain := byID["pull-plain"].ImageURL; plain == nil || *plain != "" {
		t.Fatalf("pull-plain image_url = %v, want an empty string so clients can clear covers", plain)
	}
}

func TestBookmarkRESTCarriesImageURL(t *testing.T) {
	testDB := openSyncTestDB(t)
	userID := insertAuthTestUser(t, testDB, authTestUserSeed{email: "bookmark-rest-cover@example.com", password: "password123"})
	collectionID := "rest-cover-collection"
	insertNotesCollection(t, testDB, userID, "rest-cover-workspace", collectionID)
	handler := NewBookmarkHandler(testDB, nil, pubsub.NewInMemoryHub(), fixedLimitsProvider{limits: syncTestLimits()})

	var created model.Bookmark
	decodeHandlerResponse(t, performHandlerRequest(t, userID, http.MethodPost, "/bookmarks", marshalBookmarkRequest(t, model.BookmarkRequest{
		CollectionID: &collectionID, Title: "Doc", URL: "https://doc.example.com", ImageURL: stringPtr("https://cdn.example.com/doc.png"),
	}), handler.Create), http.StatusCreated, &created)
	if created.ImageURL == nil || *created.ImageURL != "https://cdn.example.com/doc.png" {
		t.Fatalf("created image_url = %v, want the cover", created.ImageURL)
	}

	invalidCreate := performHandlerRequest(t, userID, http.MethodPost, "/bookmarks", marshalBookmarkRequest(t, model.BookmarkRequest{
		CollectionID: &collectionID, Title: "Bad", URL: "https://bad.example.com", ImageURL: stringPtr("javascript:alert(1)"),
	}), handler.Create)
	if invalidCreate.Code != http.StatusBadRequest {
		t.Fatalf("invalid create status = %d, want 400", invalidCreate.Code)
	}

	var listed []model.Bookmark
	decodeHandlerResponse(t, performHandlerRequest(t, userID, http.MethodGet, "/bookmarks", nil, handler.List), http.StatusOK, &listed)
	if len(listed) != 1 || listed[0].ImageURL == nil || *listed[0].ImageURL != "https://cdn.example.com/doc.png" {
		t.Fatalf("listed = %#v, want the created bookmark with its cover", listed)
	}

	update := func(request model.BookmarkRequest) int {
		recorder := performHandlerRequestWithParam(t, userID, http.MethodPut, "/bookmarks/"+created.ID,
			marshalBookmarkRequest(t, request), "id", created.ID, handler.Update)
		return recorder.Code
	}
	if code := update(model.BookmarkRequest{CollectionID: &collectionID, Title: "Doc renamed", URL: "https://doc.example.com"}); code != http.StatusOK {
		t.Fatalf("update without image_url status = %d", code)
	}
	if got := readStoredBookmarkImageURL(t, testDB, created.ID); got != "https://cdn.example.com/doc.png" {
		t.Fatalf("image_url = %q, want an update without image_url to keep it", got)
	}
	if code := update(model.BookmarkRequest{CollectionID: &collectionID, Title: "Doc renamed", URL: "https://doc.example.com", ImageURL: stringPtr("ftp://example.com/a.png")}); code != http.StatusBadRequest {
		t.Fatalf("invalid update status = %d, want 400", code)
	}
	if got := readStoredBookmarkImageURL(t, testDB, created.ID); got != "https://cdn.example.com/doc.png" {
		t.Fatalf("image_url = %q, want a rejected update to change nothing", got)
	}
	if code := update(model.BookmarkRequest{CollectionID: &collectionID, Title: "Doc renamed", URL: "https://doc.example.com", ImageURL: stringPtr("")}); code != http.StatusOK {
		t.Fatalf("clearing update status = %d", code)
	}
	if got := readStoredBookmarkImageURL(t, testDB, created.ID); got != "" {
		t.Fatalf("image_url = %q, want an empty string to clear it", got)
	}
}

func TestBookmarkImageURLMigrationRunsTwice(t *testing.T) {
	testDB := openSyncTestDB(t)
	if err := db.Migrate(testDB); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
	var columnDefault, nullable string
	if err := testDB.QueryRow(t.Context(), `
		SELECT column_default, is_nullable FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'bookmarks' AND column_name = 'image_url'`,
	).Scan(&columnDefault, &nullable); err != nil {
		t.Fatalf("read image_url column: %v", err)
	}
	if nullable != "NO" || !strings.HasPrefix(columnDefault, "''") {
		t.Fatalf("image_url default/nullable = %q/%q, want '' and NOT NULL", columnDefault, nullable)
	}
}
```

(`pushNotesBookmarks`, `allowNextBookmarkPush`, `insertNotesCollection`, `marshalBookmarkRequest`, `stringPtr`, `pullSync`, `openSyncTestDB`, `insertAuthTestUser`, `performHandlerRequest`, `performHandlerRequestWithParam`, `decodeHandlerResponse`, `fixedLimitsProvider`, and `syncTestLimits` already exist in this package's tests.)

- [ ] **Step 7: Run them to verify they fail**

Run: `go test ./internal/handler/ -run 'BookmarkImageURL'`
Expected: FAIL — the queries reject the unknown column `image_url` (`column "image_url" does not exist`), and the push stores nothing.

- [ ] **Step 8: Add the column**

At the end of `db/schema.pg.sql` add:

```sql
-- Bookmark cover: the page's og:image URL, which the extension reads when it
-- saves the page. '' means no cover.
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS image_url TEXT NOT NULL DEFAULT '';
```

- [ ] **Step 9: Carry the cover through sync push and pull**

In `internal/handler/sync.go`, in the bookmark loop, directly after the over-long notes check (the block that rejects with `model.RejectionReasonInvalidField`), add:

```go
		if bookmark.ImageURL != nil && *bookmark.ImageURL != "" && !model.ValidBookmarkImageURL(*bookmark.ImageURL) {
			rejected = append(rejected, model.Rejected{
				ID: bookmark.ID, Reason: model.RejectionReasonInvalidField, Type: "bookmark",
			})
			continue
		}
```

Replace the bookmark upsert statement and its arguments with:

```go
			// A push without notes or image_url (an extension that predates them)
			// keeps the stored values; a push without edited_at records the server time.
			batch.Queue(`
				INSERT INTO bookmarks (id, user_id, collection_id, title, url, favicon_url, description,
				                       is_favorite, is_archived, is_trashed, position, seq, deleted_at, created_at, updated_at, tag_ids,
				                       notes, edited_at, image_url)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,COALESCE($16::text, ''),COALESCE($17::bigint, $14),COALESCE($18::text, ''))
				ON CONFLICT (id) DO UPDATE
				  SET collection_id=$3, title=$4, url=$5, favicon_url=$6, description=$7,
				      is_favorite=$8, is_archived=$9, is_trashed=$10, position=$11, seq=$12, deleted_at=$13, updated_at=$14, tag_ids=$15,
				      notes=COALESCE($16::text, bookmarks.notes), edited_at=COALESCE($17::bigint, $14),
				      image_url=COALESCE($18::text, bookmarks.image_url)
				WHERE bookmarks.user_id = $2 AND bookmarks.updated_at < $14
				RETURNING notes`,
				bm.ID, userID, bm.CollectionID, bm.Title, bm.URL, bm.FaviconURL, bm.Description,
				bm.IsFavorite, bm.IsArchived, bm.IsTrashed, bm.Position, seq, bm.DeletedAt, now, tagIDs,
				bm.Notes, bm.EditedAt, bm.ImageURL)
```

In the pull handler's bookmark query, select `image_url` and scan it:

```go
	bmRows, err := h.db.Query(ctx,
		`SELECT id, user_id, collection_id, title, url, favicon_url, description,
                is_favorite, is_archived, is_trashed, tag_ids, position, seq, deleted_at, created_at, updated_at,
                notes, edited_at, image_url
         FROM bookmarks WHERE user_id=$1 AND seq>$2 ORDER BY seq ASC`,
		userID, afterSeq)
```

```go
		if err := bmRows.Scan(&bm.ID, &bm.UserID, &bm.CollectionID, &bm.Title, &bm.URL, &bm.FaviconURL,
			&bm.Description, &bm.IsFavorite, &bm.IsArchived, &bm.IsTrashed, &bm.TagIDs, &bm.Position,
			&bm.Seq, &bm.DeletedAt, &bm.CreatedAt, &bm.UpdatedAt, &bm.Notes, &bm.EditedAt, &bm.ImageURL); err != nil {
```

- [ ] **Step 10: Carry the cover through REST**

In `internal/handler/bookmarks.go`:

`List` — add `b.image_url` after `b.notes, b.edited_at` in the `SELECT`, and `&b.ImageURL` after `&b.EditedAt` in `rows.Scan`.

`Create` — directly after `ShouldBindJSON` succeeds, add:

```go
	imageURL := derefStr(req.ImageURL)
	if imageURL != "" && !model.ValidBookmarkImageURL(imageURL) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid image_url"})
		return
	}
```

Add `image_url` to both `INSERT` statements and `imageURL` as the last argument:

```go
			`INSERT INTO bookmarks (id, user_id, collection_id, title, url, favicon_url,
			  description, is_favorite, is_archived, is_trashed, position, seq, created_at, updated_at, notes, edited_at, image_url)
			 VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,$12,$14)`,
			id, userID, req.Title, req.URL, req.FaviconURL,
			req.Description, req.IsFavorite, req.IsArchived, boolToInt(req.IsTrashed), req.Position, seq, now, notes, imageURL,
```

```go
			`INSERT INTO bookmarks (id, user_id, collection_id, title, url, favicon_url,
			  description, is_favorite, is_archived, is_trashed, position, seq, created_at, updated_at, notes, edited_at, image_url)
			 SELECT $1,$2,c.id,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14,$13,$15
			 FROM collections c
			 JOIN workspaces w ON w.id=c.workspace_id AND w.user_id=c.user_id
			 WHERE c.id=$3 AND c.user_id=$2 AND c.deleted_at IS NULL AND c.is_deleted=0 AND w.is_deleted=0`,
			id, userID, req.CollectionID, req.Title, req.URL, req.FaviconURL,
			req.Description, req.IsFavorite, req.IsArchived, boolToInt(req.IsTrashed), req.Position, seq, now, notes, imageURL,
```

In the `201` response, add `ImageURL: &imageURL` next to `Notes: &notes`.

`Update` — directly after `ShouldBindJSON` succeeds, add:

```go
	if req.ImageURL != nil && *req.ImageURL != "" && !model.ValidBookmarkImageURL(*req.ImageURL) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid image_url"})
		return
	}
```

In the `UPDATE` statement, after `notes=COALESCE($14::text, b.notes), edited_at=$11` add `, image_url=COALESCE($15::text, b.image_url)`, update the comment above it to "Absent notes and image_url keep the stored values; the search document uses the stored notes.", and append `req.ImageURL` as the last query argument.

- [ ] **Step 11: Run the new tests**

Run: `go test ./internal/model/ ./internal/handler/ -run 'BookmarkImageURL|ValidBookmarkImageURL'`
Expected: PASS (with `TEST_DATABASE_URL` set).

- [ ] **Step 12: Run the whole server suite**

Run: `go vet ./... && go test ./...`
Expected: PASS, with no handler tests skipped for a missing database.

- [ ] **Step 13: Build and test Cloud**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-Cloud && go build ./... && go test ./...
```

Expected: PASS. Cloud needs no code change.

- [ ] **Step 14: Document the field**

In `TabSlate-server/CLAUDE.md`, after the "Bookmark notes / edited_at" bullet, add:

```markdown
- **Bookmark cover (image_url)**：`bookmarks.image_url TEXT NOT NULL DEFAULT ''`，扩展保存网页时读取的 `og:image` 地址。`model.Bookmark.ImageURL *string`，nil 表示客户端未发送：Push 与 REST 更新未发送时保留库中值，空字符串清除封面；非空值必须是绝对 http(s) 地址且不超过 `model.MaxBookmarkImageURLLength`（2,048 字符），由 `model.ValidBookmarkImageURL` 校验，否则 Push 以 `invalid_field` 拒绝该书签、REST 返回 400。Pull 与 REST 读取总是返回该字段；不进入搜索索引。
```

In `TabSlate-server/ARCHITECTURE.md`, after the "书签备注与编辑时间" bullet add:

```markdown
- **书签封面**：`image_url` 是可选字段，规则与 `notes` 相同：Push 或 REST 更新未携带时保留库中值，空字符串清除；非空值必须是不超过 2,048 字符的绝对 http(s) 地址，否则该书签以 `invalid_field` 拒绝（REST 为 400）。Pull 与 REST 读取都返回该字段。
```

and in the `bookmarks` row of the table add `, image_url TEXT` to the columns and "；`image_url` 封面地址（`NOT NULL DEFAULT ''`，最多 2,048 字符）" to the notes column.

- [ ] **Step 15: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
git add db/schema.pg.sql internal/model/model.go internal/model/model_test.go internal/handler/sync.go internal/handler/bookmarks.go internal/handler/bookmark_image_url_test.go CLAUDE.md ARCHITECTURE.md
git commit -m "feat(bookmarks): carry the bookmark cover URL

Sync and REST accept an optional image_url. A write without it keeps
the stored cover, an empty string clears it, and anything other than an
absolute http(s) URL of at most 2,048 characters is rejected.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 2: Covers in the extension's data model and sync

**Files:**
- Modify: `lib/types.ts` (`Bookmark`, `BookmarkBatchPatch`)
- Modify: `lib/api.ts` (`ServerBookmark`)
- Modify: `lib/bookmark-utils.ts` (after `MAX_BOOKMARK_NOTES_LENGTH`)
- Modify: `store/bookmarks-store.ts` (`toServerBookmark`, `patchChangesBookmark`, `applyBookmarkPatch`, `bookmarkMatchesSyncEntity`, `mergeFromServer`)
- Modify: `lib/sync-confirmation.ts` (`matchesBookmark`)
- Modify: `lib/storage.ts` (`BookmarkInput`, `storageService.addBookmark`)
- Create: `test/bookmark-cover-url.test.ts`
- Modify: `test/bookmark-sync-fields.test.ts`, `test/sync-confirmation.test.ts`, `test/storage-duplicates.test.ts`

**Interfaces:**
- Consumes: the server's `image_url` field from Task 1 (the extension also works against servers without it).
- Produces:
  - `Bookmark.imageUrl?: string` — the cover URL; missing or `""` means no cover.
  - `BookmarkBatchPatch` accepts `imageUrl`, so `updateBookmark(id, { imageUrl })` and `updateBookmarks([{ id, patch: { imageUrl } }])` change covers.
  - `ServerBookmark.image_url?: string`.
  - `MAX_BOOKMARK_IMAGE_URL_LENGTH = 2048` and `normalizeCoverUrl(raw: string, pageUrl: string): string | undefined` from `@/lib/bookmark-utils`.
  - `BookmarkInput.imageUrl?: string` for `storageService.addBookmark`.
  - Pushed bookmark entities always carry `image_url` (`""` when there is no cover).

- [ ] **Step 1: Write the failing URL normalization test**

Create `test/bookmark-cover-url.test.ts`:

```ts
// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import { MAX_BOOKMARK_IMAGE_URL_LENGTH, normalizeCoverUrl } from "@/lib/bookmark-utils";

describe("normalizeCoverUrl", () => {
  test("resolves relative and protocol-relative covers against the page", () => {
    expect(normalizeCoverUrl("/img/cover.png", "https://example.com/post/1")).toBe("https://example.com/img/cover.png");
    expect(normalizeCoverUrl("cover.png", "https://example.com/post/1")).toBe("https://example.com/post/cover.png");
    expect(normalizeCoverUrl("//cdn.example.com/a.jpg", "https://example.com/")).toBe("https://cdn.example.com/a.jpg");
  });

  test("keeps absolute http and https covers in their serialized form", () => {
    expect(normalizeCoverUrl("http://example.com/a.jpg", "https://example.com/")).toBe("http://example.com/a.jpg");
    expect(normalizeCoverUrl("  https://example.com/a b.png  ", "")).toBe("https://example.com/a%20b.png");
  });

  test("drops other schemes, data URIs and empty values", () => {
    expect(normalizeCoverUrl("javascript:alert(1)", "https://example.com/")).toBeUndefined();
    expect(normalizeCoverUrl("data:image/png;base64,AAAA", "https://example.com/")).toBeUndefined();
    expect(normalizeCoverUrl("ftp://example.com/a.png", "https://example.com/")).toBeUndefined();
    expect(normalizeCoverUrl("   ", "https://example.com/")).toBeUndefined();
  });

  test("drops a relative cover when the page URL does not parse", () => {
    expect(normalizeCoverUrl("/img/cover.png", "")).toBeUndefined();
  });

  test("accepts covers up to the length limit", () => {
    const prefix = "https://example.com/";
    const atLimit = prefix + "a".repeat(MAX_BOOKMARK_IMAGE_URL_LENGTH - prefix.length);
    expect(normalizeCoverUrl(atLimit, "")).toBe(atLimit);
    expect(normalizeCoverUrl(`${atLimit}a`, "")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/bookmark-cover-url.test.ts`
Expected: FAIL — `normalizeCoverUrl` and `MAX_BOOKMARK_IMAGE_URL_LENGTH` are not exported.

- [ ] **Step 3: Implement normalization**

In `lib/bookmark-utils.ts`, below `export const MAX_BOOKMARK_NOTES_LENGTH = 10_000;` and its comment, add:

```ts
/** The longest cover URL a bookmark stores; the server accepts up to 2,048 characters. */
export const MAX_BOOKMARK_IMAGE_URL_LENGTH = 2048;

/**
 * The cover URL to store for a page: `raw` resolved against the page URL,
 * when it is http(s) and at most MAX_BOOKMARK_IMAGE_URL_LENGTH long.
 * Undefined otherwise, which also drops data: URIs.
 */
export function normalizeCoverUrl(raw: string, pageUrl: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  let resolved: URL;
  try {
    resolved = pageUrl ? new URL(trimmed, pageUrl) : new URL(trimmed);
  } catch {
    return undefined;
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    return undefined;
  }
  return resolved.href.length <= MAX_BOOKMARK_IMAGE_URL_LENGTH ? resolved.href : undefined;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test test/bookmark-cover-url.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing sync tests**

In `test/bookmark-sync-fields.test.ts`, add `image_url: bookmark.imageUrl ?? "",` after the `notes` line of `entityFor` in the "push confirmation" block, and append this block at the end of the file:

```ts
describe("covers", () => {
  test("adding pushes the cover, and a bookmark without one pushes an empty string", () => {
    store().addBookmark({
      title: "Docs", url: "https://docs.example.com", description: "", favicon: "",
      collectionId: "reading", tags: [], seq: 0, imageUrl: "https://cdn.example.com/docs.png",
    });
    store().addBookmark({
      title: "Plain", url: "https://plain.example.com", description: "", favicon: "",
      collectionId: "reading", tags: [], seq: 0,
    });
    expect(pushedBookmarks().map((entity) => entity.image_url)).toEqual(["https://cdn.example.com/docs.png", ""]);
  });

  test("an edit that clears the cover stores and pushes an empty string", () => {
    seed([makeBookmark("b1", { collectionId: "reading", imageUrl: "https://cdn.example.com/old.png" })]);
    store().updateBookmark("b1", { imageUrl: "" });
    expect(store().bookmarks.get("b1")?.imageUrl).toBe("");
    expect(pushedBookmarks().at(-1)?.image_url).toBe("");
  });

  test("a batch patch changes the cover only when it differs", () => {
    seed([makeBookmark("b1", { collectionId: "reading", imageUrl: "https://cdn.example.com/a.png", updatedAt: 3 })]);
    store().updateBookmarks([{ id: "b1", patch: { imageUrl: "https://cdn.example.com/a.png" } }]);
    expect(pushedBookmarks()).toEqual([]);
    expect(store().bookmarks.get("b1")?.updatedAt).toBe(3);

    store().updateBookmarks([{ id: "b1", patch: { imageUrl: "https://cdn.example.com/b.png" } }]);
    expect(store().bookmarks.get("b1")?.imageUrl).toBe("https://cdn.example.com/b.png");
    expect(pushedBookmarks().at(-1)?.image_url).toBe("https://cdn.example.com/b.png");
  });

  test("merging takes the server's cover, and an empty one clears the local cover", async () => {
    seed([
      makeBookmark("b1", { collectionId: "reading", imageUrl: "https://cdn.example.com/local.png" }),
      makeBookmark("b2", { collectionId: "reading", imageUrl: "https://cdn.example.com/local.png" }),
    ]);
    await merge([
      serverBookmark("b1", { image_url: "https://cdn.example.com/remote.png" }),
      serverBookmark("b2", { image_url: "" }),
    ]);
    expect(store().bookmarks.get("b1")?.imageUrl).toBe("https://cdn.example.com/remote.png");
    expect(store().bookmarks.get("b2")?.imageUrl).toBe("");
  });

  test("merging keeps the local cover when the server predates covers", async () => {
    seed([makeBookmark("b1", { collectionId: "reading", imageUrl: "https://cdn.example.com/local.png" })]);
    await merge([serverBookmark("b1")]);
    expect(store().bookmarks.get("b1")?.imageUrl).toBe("https://cdn.example.com/local.png");
  });
});
```

and, inside `describe("push confirmation", …)`, after the existing test:

```ts
  test("a push of an older cover does not confirm the newer local bookmark", () => {
    const current = makeBookmark("b1", { collectionId: "reading", imageUrl: "https://cdn.example.com/new.png", updatedAt: 200 });
    seed([current]);

    store().confirmBookmarkEntitySeqs([entityFor({ ...current, imageUrl: "https://cdn.example.com/old.png" })], 42);
    expect(store().bookmarks.get("b1")?.seq).toBe(0);
    store().confirmBookmarkEntitySeqs([entityFor(current)], 42);
    expect(store().bookmarks.get("b1")?.seq).toBe(42);
  });
```

In `test/sync-confirmation.test.ts`, inside `describe("sync confirmation", …)`, after the "bookmark notes and edit time must match the stored bookmark" test, add:

```ts
  test("bookmark covers must match the stored bookmark, a missing cover reading as empty", () => {
    const bookmark = cases.find((confirmationCase) => confirmationCase.store === "bookmarks");
    if (!bookmark) {
      throw new Error("bookmark fixture is missing");
    }
    const { store, persisted, pushed } = bookmark;
    const cover = "https://cdn.example.test/a.png";
    expect(matchesPersistedSyncEntity(store, { ...persisted, imageUrl: cover }, pushed, [], [])).toBe(false);
    expect(matchesPersistedSyncEntity(store, { ...persisted, imageUrl: cover }, { ...pushed, image_url: cover }, [], [])).toBe(true);
    expect(matchesPersistedSyncEntity(store, persisted, { ...pushed, image_url: "" }, [], [])).toBe(true);
  });
```

In `test/storage-duplicates.test.ts`, inside `describe("storageService.addBookmark", …)`, add:

```ts
  test("writes the cover, and an empty cover when the page has none", async () => {
    const withCover = await storageService.addBookmark({
      title: "Page", url: "https://example.com/cover", favicon: "", collectionId: "reading",
      imageUrl: "https://cdn.example.com/cover.png",
    });
    const withoutCover = await storageService.addBookmark({
      title: "Page", url: "https://example.com/plain", favicon: "", collectionId: "reading",
    });
    expect(withCover.imageUrl).toBe("https://cdn.example.com/cover.png");
    expect(withoutCover.imageUrl).toBe("");
    expect(puts.at(-1)).toEqual(withoutCover);
  });
```

- [ ] **Step 6: Run them to verify they fail**

Run: `bun test test/bookmark-sync-fields.test.ts test/sync-confirmation.test.ts test/storage-duplicates.test.ts`
Expected: FAIL — pushed entities have no `image_url`, merges drop covers, the older-cover push is confirmed, and `storageService.addBookmark` returns no `imageUrl`. (`bun run compile` also reports `imageUrl` and `image_url` as unknown properties.)

- [ ] **Step 7: Add the fields**

In `lib/types.ts`, in `interface Bookmark`, after `favicon: string;` add:

```ts
  /** The page's cover (og:image) URL; a missing value or "" means no cover. */
  imageUrl?: string;
```

and change `BookmarkBatchPatch` to:

```ts
export type BookmarkBatchPatch = Partial<
  Pick<Bookmark, "title" | "url" | "description" | "notes" | "imageUrl" | "collectionId" | "tags" | "isFavorite">
>;
```

In `lib/api.ts`, in `interface ServerBookmark`, after the `notes?: string;` line add:

```ts
  /** The cover URL; absent when the server predates covers. */
  image_url?: string;
```

In `store/bookmarks-store.ts`:

- In `toServerBookmark`, after `notes: b.notes ?? "",` add `image_url: b.imageUrl ?? "",`.
- In `patchChangesBookmark`, after the `patch.notes` line add:

  ```ts
    (patch.imageUrl !== undefined && patch.imageUrl !== (bookmark.imageUrl ?? "")) ||
  ```

- In `applyBookmarkPatch`, after `notes: patch.notes ?? bookmark.notes,` add `imageUrl: patch.imageUrl ?? bookmark.imageUrl,`.
- In `bookmarkMatchesSyncEntity`, after the `entity.notes` line add:

  ```ts
    (entity.image_url ?? "") === (bookmark.imageUrl ?? "") &&
  ```

- In `mergeFromServer`, in the `merged` bookmark, after the `notes:` line add:

  ```ts
            // A server that predates covers sends none; never clear a local cover for that.
            imageUrl: serverBookmark.image_url ?? existing?.imageUrl ?? "",
  ```

In `lib/sync-confirmation.ts`, in `matchesBookmark`, after the `notes` comparison add:

```ts
    (readString(record, "imageUrl") ?? "") === (entity.image_url ?? "") &&
```

In `lib/storage.ts`, add `imageUrl?: string;` to `BookmarkInput` after `notes?: string;`, and in `storageService.addBookmark` add `imageUrl: input.imageUrl ?? "",` after `notes: input.notes ?? "",`.

- [ ] **Step 8: Run the tests and the type check**

Run: `bun test test/bookmark-cover-url.test.ts test/bookmark-sync-fields.test.ts test/sync-confirmation.test.ts test/storage-duplicates.test.ts && bun run compile`
Expected: PASS, and `tsc` reports no errors.

- [ ] **Step 9: Commit**

```bash
git add lib/types.ts lib/api.ts lib/bookmark-utils.ts store/bookmarks-store.ts lib/sync-confirmation.ts lib/storage.ts test/bookmark-cover-url.test.ts test/bookmark-sync-fields.test.ts test/sync-confirmation.test.ts test/storage-duplicates.test.ts
git commit -m "feat(bookmarks): store and sync a cover URL

Bookmarks carry an optional imageUrl that syncs as image_url, the same
way as notes: pushes always send it, an empty string clears it, and a
server without the field never clears a local cover.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- lib/types.ts lib/api.ts lib/bookmark-utils.ts store/bookmarks-store.ts lib/sync-confirmation.ts lib/storage.ts test/bookmark-cover-url.test.ts test/bookmark-sync-fields.test.ts test/sync-confirmation.test.ts test/storage-duplicates.test.ts
```

---

### Task 3: The page reader

**Files:**
- Create: `lib/page-info.ts`
- Modify: `entrypoints/content.ts` (the `GET_PAGE_INFO` branch of `handleMessage`)
- Create: `test/page-info.test.ts`, `test/content-page-info.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, from `@/lib/page-info`:
  - `interface PageInfo { title: string; url: string; selectedText: string; favicon: string; ogTitle: string; metaDescription: string; ogImage: string }` — `favicon` and `ogImage` are absolute URLs (or `""`).
  - `readPageInfo(doc?: Document, pageUrl?: string): PageInfo` — self-contained; defaults to the current page.
  - `requestPageInfo(tabId: number, options: { allowInjection: boolean }): Promise<PageInfo | null>`.
  - `GET_PAGE_INFO` answers now include `ogImage`.

- [ ] **Step 1: Write the failing reader tests**

Create `test/page-info.test.ts`:

```ts
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { setupDom, teardownDom } from "./helpers/dom-environment";
import { readPageInfo, requestPageInfo } from "@/lib/page-info";

const originalChrome = Reflect.get(globalThis, "chrome");

beforeAll(() => {
  setupDom();
});
afterEach(() => {
  Reflect.set(globalThis, "chrome", originalChrome);
  document.head.innerHTML = "";
});
afterAll(async () => {
  await teardownDom();
});

function parse(head: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><html><head>${head}</head><body></body></html>`, "text/html");
}

describe("readPageInfo", () => {
  test("reads the Open Graph tags and resolves the cover and the icon against the page", () => {
    const info = readPageInfo(parse(`
      <title>Doc title</title>
      <meta property="og:title" content=" OG title ">
      <meta property="og:description" content="OG description">
      <meta name="description" content="Meta description">
      <meta property="og:image" content="/images/cover.png">
      <link rel="icon" href="/static/icon.png">`), "https://example.com/posts/1");

    expect(info).toEqual({
      title: "Doc title",
      url: "https://example.com/posts/1",
      selectedText: "",
      favicon: "https://example.com/static/icon.png",
      ogTitle: "OG title",
      metaDescription: "OG description",
      ogImage: "https://example.com/images/cover.png",
    });
  });

  test("falls back to twitter:image and to the meta description when Open Graph values are empty", () => {
    const info = readPageInfo(parse(`
      <meta property="og:description" content="  ">
      <meta name="description" content="Meta description">
      <meta name="twitter:image" content="https://cdn.example.com/t.png">`), "https://example.com/");

    expect(info.metaDescription).toBe("Meta description");
    expect(info.ogImage).toBe("https://cdn.example.com/t.png");
    expect(info.ogTitle).toBe("");
  });

  test("reports no cover and the site's favicon.ico when the page declares neither", () => {
    const info = readPageInfo(parse("<title>Plain</title>"), "https://example.com/a/b");
    expect(info.ogImage).toBe("");
    expect(info.favicon).toBe("https://example.com/favicon.ico");
  });

  test("resolves relative URLs against the page's base element", () => {
    const info = readPageInfo(parse(`
      <base href="https://cdn.example.com/assets/">
      <meta property="og:image" content="cover.png">`), "https://example.com/post");
    expect(info.ogImage).toBe("https://cdn.example.com/assets/cover.png");
  });

  test("runs from its own source text and reads the current page, as executeScript runs it", () => {
    document.head.innerHTML = '<meta property="og:image" content="https://cdn.example.com/live.png">';
    document.title = "Live page";
    const standalone: unknown = new Function(`return (${readPageInfo.toString()})`)();
    if (typeof standalone !== "function") {
      throw new Error("the reader's source did not produce a function");
    }

    const info: unknown = standalone();

    expect(info).toMatchObject({ title: "Live page", url: location.href, ogImage: "https://cdn.example.com/live.png" });
  });
});

describe("requestPageInfo", () => {
  const injected = {
    title: "Injected", url: "https://example.com/", selectedText: "", favicon: "",
    ogTitle: "", metaDescription: "", ogImage: "https://cdn.example.com/i.png",
  };

  function stubChrome(sendMessage: () => Promise<unknown>, executeScript: () => Promise<unknown[]>) {
    const calls = { executeScript: mock(executeScript) };
    Reflect.set(globalThis, "chrome", {
      tabs: { sendMessage: mock(sendMessage) },
      scripting: { executeScript: calls.executeScript },
    });
    return calls;
  }

  test("uses the content script's answer without injecting", async () => {
    const calls = stubChrome(async () => ({ ...injected, title: "From content script" }), async () => []);
    expect((await requestPageInfo(7, { allowInjection: true }))?.title).toBe("From content script");
    expect(calls.executeScript).not.toHaveBeenCalled();
  });

  test("fills fields an answer leaves out with empty strings", async () => {
    stubChrome(async () => ({ title: "Partial", url: "https://example.com/" }), async () => []);
    expect(await requestPageInfo(7, { allowInjection: false })).toEqual({
      title: "Partial", url: "https://example.com/", selectedText: "", favicon: "",
      ogTitle: "", metaDescription: "", ogImage: "",
    });
  });

  test("runs the reader in the tab when the content script does not answer", async () => {
    const calls = stubChrome(async () => {
      throw new Error("Receiving end does not exist.");
    }, async () => [{ frameId: 0, documentId: "doc", result: injected }]);

    expect(await requestPageInfo(7, { allowInjection: true })).toEqual(injected);
    expect(calls.executeScript).toHaveBeenCalledWith({ target: { tabId: 7 }, func: readPageInfo });
  });

  test("does not inject without allowInjection", async () => {
    const calls = stubChrome(async () => undefined, async () => [{ frameId: 0, documentId: "doc", result: injected }]);
    expect(await requestPageInfo(7, { allowInjection: false })).toBeNull();
    expect(calls.executeScript).not.toHaveBeenCalled();
  });

  test("resolves to null when injection fails too", async () => {
    stubChrome(async () => {
      throw new Error("Receiving end does not exist.");
    }, async () => {
      throw new Error("Cannot access contents of the page.");
    });
    expect(await requestPageInfo(7, { allowInjection: true })).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/page-info.test.ts`
Expected: FAIL — `Cannot find module '@/lib/page-info'`.

- [ ] **Step 3: Implement the reader**

Create `lib/page-info.ts`:

```ts
/** A page's metadata, as GET_PAGE_INFO answers with it. */
export interface PageInfo {
  title: string;
  url: string;
  selectedText: string;
  favicon: string;
  ogTitle: string;
  metaDescription: string;
  /** The og:image (else twitter:image) URL resolved against the page; "" when the page declares none. */
  ogImage: string;
}

interface RequestPageInfoOptions {
  /** Run the reader in the tab when its content script does not answer; needs activeTab or host access. */
  allowInjection: boolean;
}

/**
 * Reads a page's metadata. It references nothing outside its own body, so
 * chrome.scripting.executeScript can run it from its source text, and its
 * parameters default to the page it runs in. fetchPageMetadata passes a
 * parsed document and the URL it came from.
 */
export function readPageInfo(doc: Document = document, pageUrl: string = location.href): PageInfo {
  let baseUrl = pageUrl;
  try {
    baseUrl = new URL(doc.querySelector("base[href]")?.getAttribute("href") ?? "", pageUrl).href;
  } catch {
    // Without a usable base, relative URLs resolve against the page.
  }
  const resolve = (raw: string): string => {
    try {
      return new URL(raw, baseUrl).href;
    } catch {
      return "";
    }
  };
  const firstContent = (selectors: string[]): string => {
    for (const selector of selectors) {
      const value = doc.querySelector(selector)?.getAttribute("content")?.trim();
      if (value) {
        return value;
      }
    }
    return "";
  };
  let origin = "";
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    // A page URL that does not parse gets no favicon fallback.
  }
  const iconHref = (doc.querySelector('link[rel="icon"]') ?? doc.querySelector('link[rel="shortcut icon"]'))
    ?.getAttribute("href")?.trim();
  const ogImage = firstContent(['meta[property="og:image"]', 'meta[name="twitter:image"]', 'meta[property="twitter:image"]']);
  return {
    title: doc.title,
    url: pageUrl,
    selectedText: doc.getSelection()?.toString().trim() ?? "",
    favicon: iconHref ? resolve(iconHref) : origin ? `${origin}/favicon.ico` : "",
    ogTitle: firstContent(['meta[property="og:title"]']),
    metaDescription: firstContent(['meta[property="og:description"]', 'meta[name="description"]']),
    ogImage: ogImage ? resolve(ogImage) : "",
  };
}

function readText(record: object, key: string): string {
  const value: unknown = Reflect.get(record, key);
  return typeof value === "string" ? value : "";
}

/** A page-info answer with every field present, or null when there is no answer. */
function toPageInfo(value: unknown): PageInfo | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return {
    title: readText(value, "title"),
    url: readText(value, "url"),
    selectedText: readText(value, "selectedText"),
    favicon: readText(value, "favicon"),
    ogTitle: readText(value, "ogTitle"),
    metaDescription: readText(value, "metaDescription"),
    ogImage: readText(value, "ogImage"),
  };
}

/**
 * The tab's page info: from its content script, else, with allowInjection,
 * by running readPageInfo in the tab. Null when neither works, such as on
 * browser pages or in a tab the extension has no access to.
 */
export async function requestPageInfo(tabId: number, options: RequestPageInfoOptions): Promise<PageInfo | null> {
  try {
    const info = toPageInfo(await chrome.tabs.sendMessage<{ type: "GET_PAGE_INFO" }, unknown>(tabId, { type: "GET_PAGE_INFO" }));
    if (info) {
      return info;
    }
  } catch {
    // No content script in the tab: the all-sites permission is off, or the page does not allow one.
  }
  if (!options.allowInjection) {
    return null;
  }
  try {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: readPageInfo });
    return toPageInfo(injection?.result);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test test/page-info.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing content script test**

Create `test/content-page-info.test.ts`:

```ts
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { importFresh } from "./helpers/module-replacer";
import { setupDom, teardownDom } from "./helpers/dom-environment";

type MessageListener = (message: { type?: string }, sender: object, respond: (response?: unknown) => void) => boolean;

interface ContentScriptModule {
  default: { main: (ctx: { onInvalidated: (handler: () => void) => void }) => Promise<void> };
}

const originalChrome = Reflect.get(globalThis, "chrome");
const originalDefine = Reflect.get(globalThis, "defineContentScript");
let listener: MessageListener | undefined;

beforeAll(async () => {
  setupDom();
  Reflect.set(globalThis, "defineContentScript", (config: object) => config);
  Reflect.set(globalThis, "chrome", {
    runtime: {
      onMessage: {
        addListener: (registered: MessageListener) => {
          listener = registered;
        },
        removeListener: () => {},
      },
    },
  });
  const content = await importFresh<ContentScriptModule>("entrypoints/content.ts");
  await content.default.main({ onInvalidated: () => {} });
});
afterAll(async () => {
  Reflect.set(globalThis, "chrome", originalChrome);
  Reflect.set(globalThis, "defineContentScript", originalDefine);
  await teardownDom();
});

test("answers GET_PAGE_INFO with the page reader's result, including the cover", () => {
  document.head.innerHTML = '<meta property="og:title" content="OG article"><meta property="og:image" content="https://cdn.example.com/a.png">';
  document.title = "Article";
  let answer: unknown;

  listener?.({ type: "GET_PAGE_INFO" }, {}, (response) => {
    answer = response;
  });

  expect(answer).toMatchObject({
    title: "Article",
    url: location.href,
    ogTitle: "OG article",
    ogImage: "https://cdn.example.com/a.png",
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test test/content-page-info.test.ts`
Expected: FAIL — the answer has no `ogImage`.

- [ ] **Step 7: Answer from the reader**

In `entrypoints/content.ts`, add `import { readPageInfo } from "@/lib/page-info";` below the existing import, and replace everything in `handleMessage` from `const faviconEl =` through the closing `});` of `sendResponse({…})` with:

```ts
      sendResponse(readPageInfo());
```

(The `if (message.type !== "GET_PAGE_INFO") { return false; }` line above it and the `return true;` below it stay.)

- [ ] **Step 8: Run the tests**

Run: `bun test test/page-info.test.ts test/content-page-info.test.ts test/content.test.js && bun run compile`
Expected: PASS, and `tsc` reports no errors.

- [ ] **Step 9: Commit**

```bash
git add lib/page-info.ts entrypoints/content.ts test/page-info.test.ts test/content-page-info.test.ts
git commit -m "feat(pages): read page metadata with one self-contained reader

readPageInfo returns what GET_PAGE_INFO returned plus the page's cover,
and runs both in the content script and through executeScript.
requestPageInfo asks the content script first and can fall back to
injecting the reader.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- lib/page-info.ts entrypoints/content.ts test/page-info.test.ts test/content-page-info.test.ts
```

---

### Task 4: `activeTab` and covers on every save path

**Files:**
- Modify: `wxt.config.ts` (`getPermissions`)
- Modify: `entrypoints/popup/App.tsx` (page-info request and `handleSave`)
- Modify: `entrypoints/background.ts` (context-menu handler)
- Modify: `store/tabs-store.ts` (`_saveTabsToCollectionHelper`)
- Modify: `test/wxt-config.test.ts`, `test/popup-save-ack.test.tsx`, `test/context-menu-save-ack.test.tsx`
- Create: `test/tabs-store-save-covers.test.ts`

**Interfaces:**
- Consumes: `normalizeCoverUrl` (Task 2), `Bookmark.imageUrl` and `BookmarkInput.imageUrl` (Task 2), `requestPageInfo` and `PageInfo` (Task 3).
- Produces: saved bookmarks carry `imageUrl` from the popup, the context menu (page saves only), and window or tab-group saves; the manifest grants `activeTab` in both builds.

- [ ] **Step 1: Write the failing manifest test**

In `test/wxt-config.test.ts`, after the "keeps search and tabGroups permissions for Chromium builds" test, add:

```ts
  test("grants activeTab to the Chromium and Firefox builds", async () => {
    for (const browser of ["chrome", "firefox"] as const) {
      const manifest = await getManifest(browser, 3);
      expect(manifest.permissions).toContain("activeTab");
    }
  });
```

- [ ] **Step 2: Write the failing popup tests**

In `test/popup-save-ack.test.tsx`:

1. Below `let answerSave …`, add:

   ```ts
   let pageInfoAnswer: () => Promise<unknown> = async () => ({});
   let injectionAnswer: () => Promise<unknown[]> = async () => [];
   ```

2. In the `chrome` stub, make the `GET_PAGE_INFO` branch `return pageInfoAnswer();` instead of `return {};`, and add a `scripting` member next to `tabs`:

   ```ts
       scripting: { executeScript: async () => injectionAnswer() },
   ```

3. Replace the `beforeEach` with:

   ```ts
   async function openPopup(): Promise<void> {
     view?.unmount();
     view = render(app, createElement(PopupApp));
     await wait(0);
   }

   beforeEach(async () => {
     delivered.length = 0;
     fallbackWrite.mockClear();
     pageInfoAnswer = async () => ({});
     injectionAnswer = async () => [];
     await openPopup();
   });
   ```

4. Append:

   ```ts
   function deliveredCover(): string | undefined {
     const [message] = delivered;
     return message?.type === "ADD_BOOKMARK" ? message.data.imageUrl : undefined;
   }

   test("the page's cover from the content script travels with the save, resolved against the page", async () => {
     answerSave = async () => ({ status: "saved", bookmarkId: "saved-1" });
     pageInfoAnswer = async () => ({ url: activeTab.url, ogImage: "/cover.png" });
     await openPopup();
     await save();

     expect(deliveredCover()).toBe("https://page.example.com/cover.png");
   });

   test("without a content script, the popup reads the page through activeTab", async () => {
     answerSave = async () => ({ status: "saved", bookmarkId: "saved-1" });
     pageInfoAnswer = async () => {
       throw new Error("Receiving end does not exist.");
     };
     injectionAnswer = async () => [{ result: { url: activeTab.url, ogTitle: "Injected title", ogImage: "https://cdn.example.com/injected.png" } }];
     await openPopup();
     await save();

     const [message] = delivered;
     expect(message?.type === "ADD_BOOKMARK" ? message.data.title : undefined).toBe("Injected title");
     expect(deliveredCover()).toBe("https://cdn.example.com/injected.png");
   });

   test("a cover that is not http or https is dropped", async () => {
     answerSave = async () => ({ status: "saved", bookmarkId: "saved-1" });
     pageInfoAnswer = async () => ({ url: activeTab.url, ogImage: "javascript:alert(1)" });
     await openPopup();
     await save();

     expect(deliveredCover()).toBe("");
   });

   test("the storage fallback keeps the cover", async () => {
     answerSave = async () => undefined;
     pageInfoAnswer = async () => ({ url: activeTab.url, ogImage: "https://cdn.example.com/fallback.png" });
     await openPopup();
     await save();

     expect(fallbackWrite.mock.calls[0]?.[0].imageUrl).toBe("https://cdn.example.com/fallback.png");
   });
   ```

- [ ] **Step 3: Write the failing context-menu tests**

In `test/context-menu-save-ack.test.tsx`:

1. Below `let transportFails = false;`, add:

   ```ts
   let pageInfoAnswer: () => Promise<object> = async () => input;
   let injectionAnswer: () => Promise<object[]> = async () => [];
   ```

2. In the `chrome` stub, make the `GET_PAGE_INFO` branch `return pageInfoAnswer();` instead of `return input;`, and add next to `tabs`:

   ```ts
       scripting: { executeScript: async () => injectionAnswer() },
   ```

3. In `beforeEach`, add:

   ```ts
     pageInfoAnswer = async () => input;
     injectionAnswer = async () => [];
   ```

4. Append:

   ```ts
   function storedBookmark() {
     const [bookmark] = app.useBookmarksStore.getState().bookmarks.values();
     return bookmark;
   }

   test("a page save stores the page's cover", async () => {
     setBookmarkQuota(100);
     pageInfoAnswer = async () => ({ ...input, ogImage: "https://cdn.example.com/new.png" });
     await handleSave({ menuItemId: "save-to-tabslate", editable: false }, page);
     expect(storedBookmark()?.imageUrl).toBe("https://cdn.example.com/new.png");
   });

   test("a link save does not take the current page's cover", async () => {
     setBookmarkQuota(100);
     pageInfoAnswer = async () => ({ ...input, ogImage: "https://cdn.example.com/new.png" });
     await handleSave({ menuItemId: "save-to-tabslate", editable: false, linkUrl: "https://linked.example.com/" }, page);
     expect(storedBookmark()?.url).toBe("https://linked.example.com/");
     expect(storedBookmark()?.imageUrl).toBe("");
   });

   test("without a content script, the menu click reads the page through activeTab", async () => {
     setBookmarkQuota(100);
     pageInfoAnswer = async () => {
       throw new Error("Receiving end does not exist.");
     };
     injectionAnswer = async () => [{ result: { ...input, ogImage: "https://cdn.example.com/injected.png" } }];
     await handleSave({ menuItemId: "save-to-tabslate", editable: false }, page);
     expect(storedBookmark()?.imageUrl).toBe("https://cdn.example.com/injected.png");
   });

   test("the direct-write fallback keeps the cover", async () => {
     transportFails = true;
     pageInfoAnswer = async () => ({ ...input, ogImage: "https://cdn.example.com/fallback.png" });
     await handleSave({ menuItemId: "save-to-tabslate", editable: false }, page);
     expect(Reflect.get(lastFallback ?? {}, "imageUrl")).toBe("https://cdn.example.com/fallback.png");
   });
   ```

- [ ] **Step 4: Write the failing tab-save test**

Create `test/tabs-store-save-covers.test.ts`:

```ts
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { BrowserTab } from "@/lib/chrome/tabs";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { installAppModules, setupDom, teardownDom, type AppModules } from "./helpers/dom-environment";
import { makeCollection, makeWorkspace } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
const originalChrome = Reflect.get(globalThis, "chrome");
const answers = new Map<number, object>();
let injections = 0;
let app: AppModules;
let useTabsStore: typeof import("@/store/tabs-store").useTabsStore;
let usePlanStore: typeof import("@/store/plan-store").usePlanStore;

function makeTab(id: number, url: string): BrowserTab {
  return { id, title: `Tab ${id}`, url, favIconUrl: "", windowId: 1, active: false, index: id, groupId: -1 };
}

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ usePlanStore } = await import("@/store/plan-store"));
  Reflect.set(globalThis, "chrome", {
    tabs: {
      sendMessage: async (tabId: number) => {
        const answer = answers.get(tabId);
        if (!answer) {
          throw new Error("Receiving end does not exist.");
        }
        return answer;
      },
    },
    scripting: {
      executeScript: async () => {
        injections += 1;
        return [];
      },
    },
  });
  ({ useTabsStore } = await importFresh<typeof import("@/store/tabs-store")>("store/tabs-store.ts"));
});
afterAll(async () => {
  replacer.restore();
  Reflect.set(globalThis, "chrome", originalChrome);
  await teardownDom();
});
beforeEach(() => {
  answers.clear();
  injections = 0;
  usePlanStore.setState({ limits: null, usage: null, fetchedAt: Date.now(), quotaAlert: null });
  app.useWorkspaceStore.setState({
    activeWorkspaceId: "home",
    workspaces: [makeWorkspace("home")],
    collections: [makeCollection("reading", "home", { isDefault: true })],
    tags: [],
  });
  app.useBookmarksStore.setState({ bookmarks: new Map(), countsByCollection: {} });
});

test("saving a window stores each tab's cover from its content script, without injecting", async () => {
  answers.set(1, { url: "https://one.example.com/", ogTitle: "One", ogImage: "https://cdn.example.com/one.png" });
  answers.set(2, { url: "https://two.example.com/", ogImage: "data:image/png;base64,AAAA" });
  useTabsStore.setState({
    openTabs: [makeTab(1, "https://one.example.com/"), makeTab(2, "https://two.example.com/"), makeTab(3, "https://three.example.com/")],
  });

  const result = await useTabsStore.getState().saveWindowAsCollection("Window", false);

  expect(result.saved).toBe(3);
  const byUrl = new Map([...app.useBookmarksStore.getState().bookmarks.values()].map((bookmark) => [bookmark.url, bookmark]));
  expect(byUrl.get("https://one.example.com/")?.title).toBe("One");
  expect(byUrl.get("https://one.example.com/")?.imageUrl).toBe("https://cdn.example.com/one.png");
  expect(byUrl.get("https://two.example.com/")?.imageUrl).toBe("");
  expect(byUrl.get("https://three.example.com/")?.imageUrl).toBe("");
  expect(injections).toBe(0);
});
```

- [ ] **Step 5: Run them to verify they fail**

Run: `bun test test/wxt-config.test.ts test/popup-save-ack.test.tsx test/context-menu-save-ack.test.tsx test/tabs-store-save-covers.test.ts`
Expected: FAIL — no `activeTab` permission, and no save path sets `imageUrl` (the injection tests also save without the injected title).

- [ ] **Step 6: Add the permission**

In `wxt.config.ts`, change `getPermissions` to:

```ts
function getPermissions(): string[] {
  return ["tabs", "tabGroups", "storage", "contextMenus", "scripting", "search", "activeTab"];
}
```

- [ ] **Step 7: Read covers in the popup**

In `entrypoints/popup/App.tsx`:

- Change the `@/lib/bookmark-utils` import to `import { MAX_BOOKMARK_NOTES_LENGTH, normalizeCoverUrl } from "@/lib/bookmark-utils";` and add `import { requestPageInfo } from "@/lib/page-info";`.
- Change the `pageInfo` state to:

  ```ts
  const [pageInfo, setPageInfo] = useState<{ ogTitle: string; metaDescription: string; imageUrl?: string } | null>(null);
  ```

- Replace the `chrome.tabs.sendMessage(activeTab.id, { type: "GET_PAGE_INFO" })…` statement inside `if (activeTab?.id) { … }` with:

  ```ts
            // Opening the popup grants activeTab, so the page can be read without the all-sites permission.
            void requestPageInfo(activeTab.id, { allowInjection: true }).then((info) => {
              if (info) {
                setPageInfo({
                  ogTitle: info.ogTitle,
                  metaDescription: info.metaDescription,
                  imageUrl: normalizeCoverUrl(info.ogImage, info.url),
                });
              }
            });
  ```

- In `handleSave`, add `imageUrl: pageInfo?.imageUrl ?? "",` to `bookmarkData` after the `description` line.

- [ ] **Step 8: Read covers in the context-menu save**

In `entrypoints/background.ts`, change the `@/lib/id` area imports to add:

```ts
import { normalizeCoverUrl } from "@/lib/bookmark-utils";
import { requestPageInfo } from "@/lib/page-info";
```

In the `chrome.contextMenus.onClicked` listener, replace the block from `// Try to get richer info from the content script` through the closing `};` of `bookmarkData` with:

```ts
    // The menu click grants activeTab, so the page can be read without the all-sites permission.
    const pageInfo = await requestPageInfo(tab.id, { allowInjection: true });
    // A link points to another page, which the current page's cover does not describe.
    const imageUrl = info.linkUrl ? undefined : normalizeCoverUrl(pageInfo?.ogImage ?? "", pageInfo?.url || tab.url || "");

    const bookmarkData = {
      title: pageInfo?.ogTitle || pageInfo?.title || tab.title || "Untitled",
      url: info.linkUrl ?? (pageInfo?.url || tab.url || ""),
      favicon: pageInfo?.favicon || tab.favIconUrl || "",
      description: pageInfo?.selectedText || pageInfo?.metaDescription || "",
      imageUrl: imageUrl ?? "",
      collectionId: "",
      tags: [] as string[],
      seq: 0,
    };
```

(`requestPageInfo` reports missing fields as `""`, so the URL and favicon fall back with `||`.) The IndexedDB fallback spreads `bookmarkData`, so it keeps the cover.

- [ ] **Step 9: Read covers when saving tabs as a collection**

In `store/tabs-store.ts`, change the `@/lib/bookmark-utils` import to `import { normalizeUrl, getNormalizedUrlSet, normalizeCoverUrl } from "@/lib/bookmark-utils";`, add `import { requestPageInfo } from "@/lib/page-info";`, and in `_saveTabsToCollectionHelper` replace the block from `let title = tab.title;` through the end of `newBookmarksData.push({…});` with:

```ts
    let title = tab.title;
    let description = "";
    let imageUrl = "";
    // Content script only: no user action grants access to each tab, so nothing is injected.
    const info = await requestPageInfo(tab.id, { allowInjection: false });
    if (info) {
      if (info.ogTitle) { title = info.ogTitle; }
      description = info.metaDescription;
      imageUrl = normalizeCoverUrl(info.ogImage, info.url || tab.url) ?? "";
    }
    newBookmarksData.push({
      id: generateId(),
      title,
      url: tab.url,
      favicon: tab.favIconUrl,
      description,
      imageUrl,
      tags: [],
      createdAt: now,
      isFavorite: false,
      seq: 0,
    });
```

- [ ] **Step 10: Run the tests and the type check**

Run: `bun test test/wxt-config.test.ts test/popup-save-ack.test.tsx test/context-menu-save-ack.test.tsx test/tabs-store-save-covers.test.ts test/context-menu-save.test.ts test/content.test.js && bun run compile`
Expected: PASS, and `tsc` reports no errors.

- [ ] **Step 11: Commit**

```bash
git add wxt.config.ts entrypoints/popup/App.tsx entrypoints/background.ts store/tabs-store.ts test/wxt-config.test.ts test/popup-save-ack.test.tsx test/context-menu-save-ack.test.tsx test/tabs-store-save-covers.test.ts
git commit -m "feat(bookmarks): save the page's cover from every save path

The popup, the context menu and window or tab-group saves store the
page's normalized cover. activeTab lets the popup and the context menu
read the page without the optional all-sites permission; a link saved
from the context menu never takes the current page's cover.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- wxt.config.ts entrypoints/popup/App.tsx entrypoints/background.ts store/tabs-store.ts test/wxt-config.test.ts test/popup-save-ack.test.tsx test/context-menu-save-ack.test.tsx test/tabs-store-save-covers.test.ts
```

---
### Task 5: `BookmarkCover`

**Files:**
- Create: `components/dashboard/bookmark-cover.tsx`
- Create: `test/bookmark-cover.test.tsx`

**Interfaces:**
- Consumes: `FaviconImage` (`@/components/ui/favicon-image`).
- Produces, from `@/components/dashboard/bookmark-cover`:
  - `BookmarkCover({ imageUrl?: string; url: string; favicon: string; hasDarkIcon?: boolean })` — memoized; a 1.91:1 box with the image, or the placeholder when there is no cover or it failed to load.
  - `BookmarkCoverPlaceholder({ url: string; favicon: string; hasDarkIcon?: boolean })` — `aria-hidden`, marked `data-cover-placeholder`.
  - `coverHost(url: string): string` and `coverToneIndex(host: string): number`.

- [ ] **Step 1: Write the failing tests**

Create `test/bookmark-cover.test.tsx`:

```tsx
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createModuleReplacer } from "./helpers/module-replacer";
import { installAppModules, render, setupDom, teardownDom, type AppModules } from "./helpers/dom-environment";

const replacer = createModuleReplacer();
let app: AppModules;
let BookmarkCover: typeof import("@/components/dashboard/bookmark-cover").BookmarkCover;
let coverHost: typeof import("@/components/dashboard/bookmark-cover").coverHost;
let coverToneIndex: typeof import("@/components/dashboard/bookmark-cover").coverToneIndex;

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ BookmarkCover, coverHost, coverToneIndex } = await import("@/components/dashboard/bookmark-cover"));
});
afterAll(async () => {
  replacer.restore();
  await teardownDom();
});

describe("BookmarkCover", () => {
  test("shows the cover lazily, without a referrer, as decoration", () => {
    const view = render(app, createElement(BookmarkCover, {
      imageUrl: "https://cdn.example.com/a.png", url: "https://example.com/a", favicon: "",
    }));
    const image = view.container.querySelector("img");

    expect(image?.getAttribute("src")).toBe("https://cdn.example.com/a.png");
    expect(image?.getAttribute("alt")).toBe("");
    expect(image?.getAttribute("loading")).toBe("lazy");
    expect(image?.getAttribute("decoding")).toBe("async");
    expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(image?.getAttribute("draggable")).toBe("false");
    expect(view.container.querySelector("[data-cover-placeholder]")).toBeNull();
    view.unmount();
  });

  test("shows a placeholder with the site's host when there is no cover", () => {
    const view = render(app, createElement(BookmarkCover, { url: "https://www.example.com/a", favicon: "" }));
    const placeholder = view.container.querySelector("[data-cover-placeholder]");

    expect(placeholder?.getAttribute("aria-hidden")).toBe("true");
    expect(placeholder?.textContent).toBe("example.com");
    view.unmount();
  });

  test("switches to the placeholder after a load error and does not retry when mounted again", () => {
    const props = { imageUrl: "https://cdn.example.com/broken.png", url: "https://example.com/b", favicon: "" };
    const first = render(app, createElement(BookmarkCover, props));
    const image = first.container.querySelector("img");
    act(() => {
      image?.dispatchEvent(new Event("error"));
    });
    expect(first.container.querySelector("[data-cover-placeholder]")).not.toBeNull();
    first.unmount();

    const second = render(app, createElement(BookmarkCover, props));
    expect(second.container.querySelector('img[src="https://cdn.example.com/broken.png"]')).toBeNull();
    expect(second.container.querySelector("[data-cover-placeholder]")).not.toBeNull();
    second.unmount();
  });

  test("bookmarks on one site share a placeholder color", () => {
    const first = render(app, createElement(BookmarkCover, { url: "https://example.com/1", favicon: "" }));
    const second = render(app, createElement(BookmarkCover, { url: "https://www.example.com/2", favicon: "" }));

    expect(first.container.querySelector("[data-cover-placeholder]")?.className)
      .toBe(second.container.querySelector("[data-cover-placeholder]")?.className);
    first.unmount();
    second.unmount();
  });
});

describe("placeholder colors", () => {
  test("a host always maps to the same tone, and hosts spread across tones", () => {
    expect(coverToneIndex("example.com")).toBe(coverToneIndex("example.com"));
    const tones = new Set(["a.com", "b.org", "c.net", "d.io", "e.dev", "f.app", "g.co", "h.me"].map(coverToneIndex));
    expect(tones.size).toBeGreaterThan(1);
  });

  test("the host drops www. and is empty for an address that does not parse", () => {
    expect(coverHost("https://www.example.com/x")).toBe("example.com");
    expect(coverHost("not a url")).toBe("");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/bookmark-cover.test.tsx`
Expected: FAIL — `Cannot find module '@/components/dashboard/bookmark-cover'`.

- [ ] **Step 3: Implement the cover**

Create `components/dashboard/bookmark-cover.tsx`:

```tsx
import * as React from "react";
import { FaviconImage } from "@/components/ui/favicon-image";
import { cn } from "@/lib/utils";

/** Covers that failed to load this page session; cards that mount again do not retry them. */
const failedCoverUrls = new Set<string>();

/** Soft placeholder backgrounds, picked by host so a site keeps its color. */
const COVER_PLACEHOLDER_TONES = [
  "bg-sky-100 dark:bg-sky-950/60",
  "bg-emerald-100 dark:bg-emerald-950/60",
  "bg-amber-100 dark:bg-amber-950/60",
  "bg-rose-100 dark:bg-rose-950/60",
  "bg-violet-100 dark:bg-violet-950/60",
  "bg-teal-100 dark:bg-teal-950/60",
  "bg-orange-100 dark:bg-orange-950/60",
  "bg-indigo-100 dark:bg-indigo-950/60",
];

/** The host of a bookmark's address without "www.", or "" when the address does not parse. */
export function coverHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** A stable placeholder tone for a host (FNV-1a hash). */
export function coverToneIndex(host: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < host.length; index += 1) {
    hash ^= host.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % COVER_PLACEHOLDER_TONES.length;
}

interface BookmarkCoverPlaceholderProps {
  url: string;
  favicon: string;
  hasDarkIcon?: boolean;
}

/** The site's icon and host on a tone of its own; the card's title names the bookmark. */
export function BookmarkCoverPlaceholder({ url, favicon, hasDarkIcon }: BookmarkCoverPlaceholderProps) {
  const host = coverHost(url);
  return (
    <div
      aria-hidden="true"
      data-cover-placeholder=""
      className={cn(
        "flex size-full flex-col items-center justify-center gap-2 text-muted-foreground",
        COVER_PLACEHOLDER_TONES[coverToneIndex(host)],
      )}
    >
      <FaviconImage src={favicon} className="size-8" hasDarkIcon={hasDarkIcon} />
      {host && <span className="max-w-[80%] truncate text-xs font-medium">{host}</span>}
    </div>
  );
}

interface BookmarkCoverProps {
  imageUrl?: string;
  url: string;
  favicon: string;
  hasDarkIcon?: boolean;
}

/** A large card's cover: the page's image at the og:image ratio, else the placeholder. */
export const BookmarkCover = React.memo(function BookmarkCover({ imageUrl, url, favicon, hasDarkIcon }: BookmarkCoverProps) {
  const [failedUrl, setFailedUrl] = React.useState("");
  const cover = imageUrl && imageUrl !== failedUrl && !failedCoverUrls.has(imageUrl) ? imageUrl : "";

  const handleError = React.useCallback(() => {
    if (!imageUrl) {
      return;
    }
    failedCoverUrls.add(imageUrl);
    setFailedUrl(imageUrl);
  }, [imageUrl]);

  return (
    <div className="aspect-[1.91/1] w-full overflow-hidden rounded-t-xl bg-muted">
      {cover ? (
        <img
          src={cover}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          className="size-full object-cover"
          onError={handleError}
        />
      ) : (
        <BookmarkCoverPlaceholder url={url} favicon={favicon} hasDarkIcon={hasDarkIcon} />
      )}
    </div>
  );
});
```

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test test/bookmark-cover.test.tsx && bun run compile`
Expected: PASS, and `tsc` reports no errors.

- [ ] **Step 5: Commit**

```bash
git add components/dashboard/bookmark-cover.tsx test/bookmark-cover.test.tsx
git commit -m "feat(bookmarks): add the bookmark cover and its placeholder

The cover shows a page's image at the og:image ratio without sending a
referrer. Missing and broken covers show the site's icon and host on a
color picked from the host, and broken URLs are not retried.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- components/dashboard/bookmark-cover.tsx test/bookmark-cover.test.tsx
```

---

### Task 6: The large card view replaces the list view

**Files:**
- Modify: `lib/view-preferences.ts` (`BookmarkViewMode`, `VIEW_MODES`)
- Modify: `components/dashboard/header.tsx` (view toggle)
- Modify: `components/dashboard/bookmark-card.tsx` (variants, `SelectionCheckbox`)
- Modify: `components/dashboard/content.tsx` (`DraggableBookmarkCard`, rows, row estimate)
- Modify: `components/dashboard/favorites-content.tsx` (card grid)
- Modify: `components/dashboard/tabs-dnd-provider.tsx` (`BookmarkDragData`, `DragPreview`)
- Modify: `public/_locales/en/messages.json`, `public/_locales/zh_CN/messages.json`
- Create: `test/bookmark-card-gallery.test.tsx`
- Modify: `test/view-preferences.test.ts`, `test/settings-store-view-prefs.test.ts`, `test/bookmarks-header-subscription.test.tsx`, `test/bookmark-selection.test.tsx`, `test/library-selection.test.tsx`, `test/library-visible-filters.test.tsx`, `test/bookmark-notes-popover.test.tsx`, `test/bookmark-card-menu.test.tsx`

**Interfaces:**
- Consumes: `BookmarkCover` (Task 5), `Bookmark.imageUrl` (Task 2).
- Produces:
  - `BookmarkViewMode = "grid" | "gallery"` from `@/lib/view-preferences`; a stored `"list"` parses to `"grid"`.
  - `BookmarkCard`'s `variant?: BookmarkViewMode`; a gallery card renders `<div data-bookmark-cover>` (cover and selection checkbox) as its first child.
  - `SelectionCheckbox`'s new `placement?: "favicon" | "cover"` prop (default `"favicon"`).
  - `BookmarkDragData` gains `imageUrl: string`, and its `variant` is a `BookmarkViewMode`.
  - i18n keys `header_viewModes`, `header_viewSmallCards`, `header_viewLargeCards`.

- [ ] **Step 1: Move the existing tests off the list view**

```bash
perl -pi -e 's/"list"/"gallery"/g' test/view-preferences.test.ts test/settings-store-view-prefs.test.ts
perl -pi -e 's/viewMode: "list"/viewMode: "grid"/' test/library-selection.test.tsx test/bookmark-selection.test.tsx test/library-visible-filters.test.tsx
perl -pi -e 's/variant: "list"/variant: "grid"/g' test/bookmark-notes-popover.test.tsx
perl -pi -e 's/Array<"grid" \| "list"> = \["grid", "list"\]/Array<"grid" | "gallery"> = ["grid", "gallery"]/' test/bookmark-card-menu.test.tsx
```

Then check what still uses the list view: `grep -rn '"list"' test/` prints only `test/bookmarks-header-subscription.test.tsx`, whose test Step 2 replaces.

- [ ] **Step 2: Write the failing view tests**

In `test/view-preferences.test.ts`, next to the test that parses `{ viewMode: "masonry", sortBy: "random" }`, add:

```ts
  test("a list view stored before large cards falls back to small cards", () => {
    expect(viewPrefs.parseViewPrefs({ viewMode: "list", sortBy: "alpha-za", updatedAt: 42 })).toEqual({
      viewMode: "grid",
      sortBy: "alpha-za",
      updatedAt: 42,
    });
  });
```

In `test/bookmarks-header-subscription.test.tsx`, replace the test "highlights the list toggle after switching to list view" with:

```ts
  test("presses the large-card toggle after switching to large cards", () => {
    act(() => {
      useBookmarksStore.getState().setViewMode("grid");
    });
    const header = renderHeader();

    act(() => {
      useBookmarksStore.getState().setViewMode("gallery");
    });

    const group = header.container.querySelector('[role="group"][aria-label="header_viewModes"]');
    const small = group?.querySelector('[aria-label="header_viewSmallCards"]');
    const large = group?.querySelector('[aria-label="header_viewLargeCards"]');
    expect(large?.getAttribute("aria-pressed")).toBe("true");
    expect(large?.className).toContain("bg-muted");
    expect(small?.getAttribute("aria-pressed")).toBe("false");
    expect(small?.className).not.toContain("bg-muted");
    header.unmount();
  });

  test("the small-card toggle switches back to small cards", () => {
    act(() => {
      useBookmarksStore.getState().setViewMode("gallery");
    });
    const header = renderHeader();
    const small = header.container.querySelector('[aria-label="header_viewSmallCards"]');
    if (!small) {
      throw new Error("the small-card toggle is missing");
    }

    click(small);

    expect(useBookmarksStore.getState().viewMode).toBe("grid");
    header.unmount();
  });
```

In `test/bookmark-selection.test.tsx`, replace the test "grid cards expose the same selectable checkbox and selected state" with:

```ts
  test("large cards expose the same selectable checkbox, on the cover", () => {
    act(() => { app.useBookmarksStore.setState({ viewMode: "gallery" }); });
    expect(checkbox("c").closest("[data-bookmark-cover]")).not.toBeNull();
    click(checkbox("c"));
    expect(checkbox("c").getAttribute("aria-checked")).toBe("true");
    expect(card("c").hasAttribute("data-selected")).toBe(true);
    expect(smartOpenUrl).not.toHaveBeenCalled();
  });
```

In `test/library-visible-filters.test.tsx`, append:

```ts
test("the large card view shows covers in the library and in Favorites", () => {
  const bookmarks = [
    makeBookmark("covered", { collectionId: "reading", isFavorite: true, imageUrl: "https://cdn.example.com/covered.png" }),
    makeBookmark("bare", { collectionId: "reading", isFavorite: true }),
  ];
  app.useBookmarksStore.setState({ bookmarks: bookmarkMap(bookmarks), countsByCollection: countsByCollection(bookmarks), viewMode: "gallery" });

  view = render(app, createElement(MemoryRouter, null, createElement(BookmarksContent)));
  expect(getBySelector('[data-bookmark-id="covered"] [data-bookmark-cover] img').getAttribute("src")).toBe("https://cdn.example.com/covered.png");
  expect(getBySelector('[data-bookmark-id="bare"] [data-bookmark-cover] [data-cover-placeholder]')).toBeTruthy();

  view.unmount();
  view = render(app, createElement(FavoritesContent));
  expect(getBySelector('[data-bookmark-id="covered"] [data-bookmark-cover] img').getAttribute("src")).toBe("https://cdn.example.com/covered.png");
});
```

Create `test/bookmark-card-gallery.test.tsx`:

```tsx
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { act, createElement } from "react";
import type { Bookmark } from "@/lib/types";
import type { BookmarkViewMode } from "@/lib/view-preferences";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { click, getBySelector, installAppModules, render, setupDom, teardownDom, type AppModules, type RenderResult } from "./helpers/dom-environment";
import { makeBookmark } from "./helpers/library-fixtures";

const replacer = createModuleReplacer();
let app: AppModules;
let BookmarkCard: typeof import("@/components/dashboard/bookmark-card").BookmarkCard;
let SelectionOrdersProvider: typeof import("@/components/dashboard/shared/selection-orders").SelectionOrdersProvider;
let useSelectionStore: typeof import("@/store/selection-store").useSelectionStore;
let view: RenderResult | null = null;

const covered = makeBookmark("covered", { title: "Covered", collectionId: "reading", imageUrl: "https://cdn.example.com/covered.png" });
const bare = makeBookmark("bare", { title: "Bare", url: "https://www.bare.example.com/page", collectionId: "reading" });

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ useSelectionStore } = await import("@/store/selection-store"));
  ({ SelectionOrdersProvider } = await import("@/components/dashboard/shared/selection-orders"));
  ({ BookmarkCard } = await importFresh<typeof import("@/components/dashboard/bookmark-card")>("components/dashboard/bookmark-card.tsx"));
});
afterAll(async () => {
  view?.unmount();
  replacer.restore();
  await teardownDom();
});
beforeEach(() => {
  view?.unmount();
  view = null;
  act(() => useSelectionStore.getState().clear());
});

function renderCard(bookmark: Bookmark, variant: BookmarkViewMode): HTMLElement {
  view = render(app, createElement(SelectionOrdersProvider, {
    viewOrder: [bookmark.id],
    onScreenOrder: [bookmark.id],
    children: createElement(BookmarkCard, { bookmark, variant }),
  }));
  return getBySelector(`[data-bookmark-id="${bookmark.id}"]`);
}

test("a large card shows the cover above the small card's title, address and menu", () => {
  const card = renderCard(covered, "gallery");

  expect(card.firstElementChild?.hasAttribute("data-bookmark-cover")).toBe(true);
  expect(card.querySelector("[data-bookmark-cover] img")?.getAttribute("src")).toBe("https://cdn.example.com/covered.png");
  expect(card.querySelector("h3")?.className).toContain("line-clamp-2");
  expect(card.textContent).toContain("https://example.com/covered");
  expect(card.querySelector('[aria-label="bookmarkCard_moreActions"]')).not.toBeNull();
});

test("a large card without a cover shows the site's placeholder", () => {
  const card = renderCard(bare, "gallery");
  expect(card.querySelector("[data-bookmark-cover] [data-cover-placeholder]")?.textContent).toBe("bare.example.com");
});

test("the selection checkbox sits on the cover, and only there", () => {
  const card = renderCard(covered, "gallery");
  const boxes = card.querySelectorAll('[role="checkbox"]');
  expect(boxes).toHaveLength(1);
  expect(boxes[0]?.closest("[data-bookmark-cover]")).not.toBeNull();

  click(getBySelector('[data-bookmark-id="covered"] [role="checkbox"]'));

  expect(useSelectionStore.getState().selectedIds.has("covered")).toBe(true);
  expect(getBySelector('[data-bookmark-id="covered"] [role="checkbox"]').getAttribute("aria-checked")).toBe("true");
});

test("a small card has no cover and keeps its checkbox on the favicon", () => {
  const card = renderCard(covered, "grid");
  expect(card.querySelector("[data-bookmark-cover]")).toBeNull();
  expect(card.querySelector('img[src="https://cdn.example.com/covered.png"]')).toBeNull();
  expect(card.querySelector('[role="checkbox"]')).not.toBeNull();
  expect(card.querySelector("h3")?.className).toContain("truncate");
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `bun test test/view-preferences.test.ts test/settings-store-view-prefs.test.ts test/bookmarks-header-subscription.test.tsx test/bookmark-selection.test.tsx test/library-visible-filters.test.tsx test/bookmark-card-gallery.test.tsx test/bookmark-card-menu.test.tsx`
Expected: FAIL — `gallery` parses to `grid`, the header has no labelled toggle, and cards render no cover.

- [ ] **Step 4: Switch the view mode**

In `lib/view-preferences.ts`:

```ts
export type BookmarkViewMode = "grid" | "gallery";
```

```ts
const VIEW_MODES: readonly BookmarkViewMode[] = ["grid", "gallery"];
```

- [ ] **Step 5: Label the header toggle**

In `components/dashboard/header.tsx`, replace `List,` in the `lucide-react` import with `GalleryVerticalEnd,`, and replace the toggle's `<div className="flex items-center border rounded-md p-0.5">…</div>` with:

```tsx
          <div role="group" aria-label={t("header_viewModes")} className="flex items-center border rounded-md p-0.5">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("header_viewSmallCards")}
              aria-pressed={viewMode === "grid"}
              className={cn("rounded-sm", viewMode === "grid" && "bg-muted")}
              onClick={() => setViewMode("grid")}
            >
              <LayoutGrid className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("header_viewLargeCards")}
              aria-pressed={viewMode === "gallery"}
              className={cn("rounded-sm", viewMode === "gallery" && "bg-muted")}
              onClick={() => setViewMode("gallery")}
            >
              <GalleryVerticalEnd className="size-4" />
            </Button>
          </div>
```

Add to `public/_locales/en/messages.json`, after `header_addBookmark`:

```json
  "header_viewModes": {
    "message": "View"
  },
  "header_viewSmallCards": {
    "message": "Small cards"
  },
  "header_viewLargeCards": {
    "message": "Large cards"
  },
```

and to `public/_locales/zh_CN/messages.json`, after `header_addBookmark`:

```json
  "header_viewModes": {
    "message": "视图"
  },
  "header_viewSmallCards": {
    "message": "小卡片"
  },
  "header_viewLargeCards": {
    "message": "大卡片"
  },
```

- [ ] **Step 6: Give `BookmarkCard` a gallery variant and drop the list variant**

In `components/dashboard/bookmark-card.tsx`:

1. Remove `ExternalLink,` from the `lucide-react` import (only the list variant used it), and add:

   ```ts
   import { BookmarkCover } from "@/components/dashboard/bookmark-cover";
   import type { BookmarkViewMode } from "@/lib/view-preferences";
   ```

2. In `BookmarkCardProps`, change `variant?: "grid" | "list";` to `variant?: BookmarkViewMode;`.

3. Replace `SelectionCheckboxProps` and `SelectionCheckbox`'s signature and class list with:

   ```tsx
   interface SelectionCheckboxProps {
     title: string;
     checked: boolean;
     /** Shown without hovering, e.g. while any card is selected. */
     visible: boolean;
     /** "favicon" covers the favicon square, so showing it never shifts the layout; "cover" sits on a large card's cover. */
     placement?: "favicon" | "cover";
     onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
   }

   export function SelectionCheckbox({ title, checked, visible, placement = "favicon", onClick }: SelectionCheckboxProps) {
   ```

   and in its `<button>`:

   ```tsx
         className={cn(
           "absolute flex items-center justify-center transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
           placement === "cover" ? "left-2 top-2 size-7 rounded-md bg-background/90 shadow-sm" : "inset-0 bg-muted",
           visible ? "opacity-100" : "opacity-0 group-hover:opacity-100",
         )}
   ```

   (Drop the old `/** Covers the favicon square… */` comment above the function; the prop comment replaces it.)

4. Delete the whole `// ── List variant ──` block, from that comment through the closing `}` of `if (variant === "list") { … }`.

5. Change the comment `// ── Grid variant (compact, redesigned) ──…` to `// ── Small and large cards: a large card adds the cover on top ──`, and directly inside the card's root `<div …>` (before `{/* Header: favicon + title + slide-in actions */}`) add:

   ```tsx
             {variant === "gallery" && (
               <div className="relative" data-bookmark-cover="">
                 <BookmarkCover
                   imageUrl={bookmark.imageUrl}
                   url={bookmark.url}
                   favicon={bookmark.favicon}
                   hasDarkIcon={bookmark.hasDarkIcon}
                 />
                 {selectable && (
                   <SelectionCheckbox
                     title={bookmark.title}
                     checked={isSelected}
                     visible={selectionActive}
                     placement="cover"
                     onClick={handleCheckboxClick}
                   />
                 )}
               </div>
             )}
   ```

6. In the favicon square, change `{selectable && (` to `{selectable && variant === "grid" && (`.

7. Change the title element to:

   ```tsx
               <h3 className={cn("flex-1 text-sm font-medium min-w-0", variant === "gallery" ? "line-clamp-2" : "truncate")}>
   ```

- [ ] **Step 7: Render large cards in the library, Favorites and the drag preview**

In `components/dashboard/content.tsx`:

1. Add `import type { BookmarkViewMode } from "@/lib/view-preferences";`.
2. In `DraggableBookmarkCardProps`, change `variant?: "grid" | "list";` to `variant?: BookmarkViewMode;`, and add `imageUrl: bookmark.imageUrl ?? "",` to `dragData` after `favicon`.
3. Delete `const actualCols = viewMode === "grid" ? gridCols : 1;`.
4. In the rows `useMemo`, change `const columns = viewMode === "grid" ? gridCols : 1;` to `const columns = gridCols;`, and remove `viewMode` from that `useMemo`'s dependency list.
5. In `estimateSize`, change the last line to `return viewMode === "gallery" ? 300 : 156;`.
6. In the `bookmarks_row` branch, replace the `style={…}` and `className={…}` props of `DroppableCollectionBand` with:

   ```tsx
                     style={{ gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))` }}
                     className="grid gap-4 px-4 md:px-6 py-2"
   ```

In `components/dashboard/favorites-content.tsx`, replace the `{viewMode === "grid" ? ( … ) : ( … )}` block with:

```tsx
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {favoriteBookmarks.map((bookmark) => (
              <BookmarkCard key={bookmark.id} bookmark={bookmark} variant={viewMode} />
            ))}
          </div>
```

In `components/dashboard/tabs-dnd-provider.tsx`, add `import type { BookmarkViewMode } from "@/lib/view-preferences";`, change `BookmarkDragData` to:

```ts
export type BookmarkDragData = {
  type: "bookmark";
  bookmarkId: string;
  title: string;
  url: string;
  favicon: string;
  imageUrl: string;
  variant: BookmarkViewMode;
};
```

and add `imageUrl: data.imageUrl,` to `fakeBookmark` in `DragPreview`, after `favicon`.

- [ ] **Step 8: Run the tests and the type check**

Run: `bun test test/view-preferences.test.ts test/settings-store-view-prefs.test.ts test/bookmarks-header-subscription.test.tsx test/bookmark-selection.test.tsx test/library-selection.test.tsx test/library-visible-filters.test.tsx test/bookmark-notes-popover.test.tsx test/bookmark-card-menu.test.tsx test/bookmark-card-gallery.test.tsx test/bookmark-cover.test.tsx && bun run compile`
Expected: PASS, and `tsc` reports no errors (it would flag any `"list"` view value left behind).

- [ ] **Step 9: Commit**

```bash
git add lib/view-preferences.ts components/dashboard/header.tsx components/dashboard/bookmark-card.tsx components/dashboard/content.tsx components/dashboard/favorites-content.tsx components/dashboard/tabs-dnd-provider.tsx public/_locales/en/messages.json public/_locales/zh_CN/messages.json test/bookmark-card-gallery.test.tsx test/view-preferences.test.ts test/settings-store-view-prefs.test.ts test/bookmarks-header-subscription.test.tsx test/bookmark-selection.test.tsx test/library-selection.test.tsx test/library-visible-filters.test.tsx test/bookmark-notes-popover.test.tsx test/bookmark-card-menu.test.tsx
git commit -m "feat(bookmarks): replace the list view with large cards

Large cards are small cards with the page's cover on top, laid out in
the same columns in the library and in Favorites. The selection
checkbox moves onto the cover, the view toggle gets labels and pressed
states, and a stored list view opens as small cards.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- lib/view-preferences.ts components/dashboard/header.tsx components/dashboard/bookmark-card.tsx components/dashboard/content.tsx components/dashboard/favorites-content.tsx components/dashboard/tabs-dnd-provider.tsx public/_locales/en/messages.json public/_locales/zh_CN/messages.json test/bookmark-card-gallery.test.tsx test/view-preferences.test.ts test/settings-store-view-prefs.test.ts test/bookmarks-header-subscription.test.tsx test/bookmark-selection.test.tsx test/library-selection.test.tsx test/library-visible-filters.test.tsx test/bookmark-notes-popover.test.tsx test/bookmark-card-menu.test.tsx
```

---
### Task 7: "Fetch details" in the bookmark form

**Files:**
- Create: `lib/page-metadata.ts`
- Modify: `components/dashboard/shared/bookmark-form.tsx`
- Modify: `public/_locales/en/messages.json`, `public/_locales/zh_CN/messages.json`
- Create: `test/page-metadata.test.ts`
- Modify: `test/bookmark-form.test.tsx`

**Interfaces:**
- Consumes: `readPageInfo` (Task 3), `normalizeCoverUrl` and `BookmarkBatchPatch.imageUrl` (Task 2).
- Produces, from `@/lib/page-metadata`:
  - `FETCH_DETAILS_TIMEOUT_MS = 10_000`, `FETCH_DETAILS_MAX_BYTES = 2 * 1024 * 1024`.
  - `interface PageMetadata { title: string; description: string; imageUrl: string }`.
  - `type FetchPageMetadataError = "timeout" | "network" | "http" | "not-html" | "no-metadata"`.
  - `type FetchPageMetadataResult = { status: "ok"; metadata: PageMetadata } | { status: "error"; reason: FetchPageMetadataError }`.
  - `siteAccessPattern(url: string): string`, `requestSiteAccess(url: string): Promise<boolean>`.
  - `fetchPageMetadata(url: string, timeoutMs?: number): Promise<FetchPageMetadataResult>`.
- The form's address field gains a "Fetch details" button, a cover thumbnail marked `data-form-cover`, and "Use fetched" suggestions under the title and description.

- [ ] **Step 1: Write the failing fetcher tests**

Create `test/page-metadata.test.ts`:

```ts
// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { setupDom, teardownDom } from "./helpers/dom-environment";
import { FETCH_DETAILS_MAX_BYTES, fetchPageMetadata, siteAccessPattern } from "@/lib/page-metadata";

// happy-dom installs its own fetch; each test replaces it and afterEach puts it back.
let originalFetch: unknown;
let requests: Array<{ url: string; init: RequestInit | undefined }> = [];

beforeAll(() => {
  setupDom();
  originalFetch = Reflect.get(globalThis, "fetch");
});
afterEach(() => {
  Reflect.set(globalThis, "fetch", originalFetch);
  requests = [];
});
afterAll(async () => {
  await teardownDom();
});

function serve(respond: (url: string, init: RequestInit | undefined) => Promise<Response>): void {
  Reflect.set(globalThis, "fetch", async (input: string, init?: RequestInit) => {
    requests.push({ url: input, init });
    return respond(input, init);
  });
}

function html(head: string, contentType = "text/html; charset=utf-8"): () => Promise<Response> {
  return async () => new Response(`<!doctype html><html><head>${head}</head><body></body></html>`, { headers: { "content-type": contentType } });
}

describe("fetchPageMetadata", () => {
  test("requests the page without cookies and reads its Open Graph details", async () => {
    serve(html('<title>Doc</title><meta property="og:title" content="OG title"><meta property="og:description" content="OG description"><meta property="og:image" content="https://cdn.example.com/c.png">'));

    expect(await fetchPageMetadata("https://example.com/a")).toEqual({
      status: "ok",
      metadata: { title: "OG title", description: "OG description", imageUrl: "https://cdn.example.com/c.png" },
    });
    expect(requests[0]?.init?.credentials).toBe("omit");
    expect(requests[0]?.init?.redirect).toBe("follow");
  });

  test("falls back to the title element, the meta description and twitter:image", async () => {
    serve(html('<title>Doc title</title><meta name="description" content="Meta description"><meta name="twitter:image" content="https://cdn.example.com/t.png">'));

    expect(await fetchPageMetadata("https://example.com/a")).toEqual({
      status: "ok",
      metadata: { title: "Doc title", description: "Meta description", imageUrl: "https://cdn.example.com/t.png" },
    });
  });

  test("resolves a relative cover against the final response URL", async () => {
    serve(async () => {
      const response = new Response('<html><head><meta property="og:image" content="/c.png"></head></html>', { headers: { "content-type": "text/html" } });
      Object.defineProperty(response, "url", { value: "https://final.example.com/post" });
      return response;
    });

    const result = await fetchPageMetadata("https://example.com/redirecting");

    expect(result.status === "ok" ? result.metadata.imageUrl : "").toBe("https://final.example.com/c.png");
  });

  test("decodes the charset a meta tag declares when the header has none", async () => {
    const encoder = new TextEncoder();
    const bytes = new Uint8Array([
      ...encoder.encode('<html><head><meta charset="gbk"><title>'),
      0xc4, 0xe3, 0xba, 0xc3, // 你好 in GBK
      ...encoder.encode("</title></head></html>"),
    ]);
    serve(async () => new Response(bytes, { headers: { "content-type": "text/html" } }));

    const result = await fetchPageMetadata("https://example.cn/");

    expect(result.status === "ok" ? result.metadata.title : "").toBe("你好");
  });

  test("reads no more than the size limit of a huge page", async () => {
    let pulled = 0;
    const filler = new Uint8Array(64 * 1024).fill(0x61);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const head = new TextEncoder().encode('<html><head><meta property="og:title" content="Huge"></head><body>');
        pulled += head.length;
        controller.enqueue(head);
      },
      pull(controller) {
        pulled += filler.length;
        controller.enqueue(filler);
      },
    });
    serve(async () => new Response(stream, { headers: { "content-type": "text/html" } }));

    const result = await fetchPageMetadata("https://huge.example.com/");

    expect(result).toEqual({ status: "ok", metadata: { title: "Huge", description: "", imageUrl: "" } });
    expect(pulled).toBeLessThan(FETCH_DETAILS_MAX_BYTES + 4 * filler.length);
  });

  test("reports pages that are not HTML, failed responses and pages without details", async () => {
    serve(async () => new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } }));
    expect(await fetchPageMetadata("https://example.com/a.pdf")).toEqual({ status: "error", reason: "not-html" });

    serve(async () => new Response("missing", { status: 404, headers: { "content-type": "text/html" } }));
    expect(await fetchPageMetadata("https://example.com/missing")).toEqual({ status: "error", reason: "http" });

    serve(html(""));
    expect(await fetchPageMetadata("https://example.com/empty")).toEqual({ status: "error", reason: "no-metadata" });
  });

  test("reports network errors and timeouts", async () => {
    serve(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await fetchPageMetadata("https://down.example.com/")).toEqual({ status: "error", reason: "network" });

    serve((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    expect(await fetchPageMetadata("https://slow.example.com/", 20)).toEqual({ status: "error", reason: "timeout" });
  });
});

test("site access asks for the page's host on its scheme, without the port or path", () => {
  expect(siteAccessPattern("https://www.example.com:8443/a/b?c=1")).toBe("https://www.example.com/*");
  expect(siteAccessPattern("http://localhost:3000/")).toBe("http://localhost/*");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/page-metadata.test.ts`
Expected: FAIL — `Cannot find module '@/lib/page-metadata'`.

- [ ] **Step 3: Implement the fetcher**

Create `lib/page-metadata.ts`:

```ts
import { normalizeCoverUrl } from "@/lib/bookmark-utils";
import { readPageInfo } from "@/lib/page-info";

export const FETCH_DETAILS_TIMEOUT_MS = 10_000;
export const FETCH_DETAILS_MAX_BYTES = 2 * 1024 * 1024;

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);

export interface PageMetadata {
  title: string;
  description: string;
  /** The normalized cover URL; "" when the page declares none. */
  imageUrl: string;
}

export type FetchPageMetadataError = "timeout" | "network" | "http" | "not-html" | "no-metadata";

export type FetchPageMetadataResult =
  | { status: "ok"; metadata: PageMetadata }
  | { status: "error"; reason: FetchPageMetadataError };

/** The match pattern for a page's site, e.g. "https://example.com/*"; match patterns carry no port. */
export function siteAccessPattern(url: string): string {
  const { protocol, hostname } = new URL(url);
  return `${protocol}//${hostname}/*`;
}

/**
 * Asks for access to the page's site, which resolves true at once when the
 * all-sites permission is granted. Call it in the click handler before any
 * await: browsers grant permission requests only during the user's gesture.
 */
export function requestSiteAccess(url: string): Promise<boolean> {
  return chrome.permissions.request({ origins: [siteAccessPattern(url)] });
}

/** At most maxBytes of the body. Pages declare their metadata in <head>, so a cut-off body still parses. */
async function readLimitedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    return new Uint8Array();
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (received < maxBytes) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = value.subarray(0, maxBytes - received);
    chunks.push(chunk);
    received += chunk.length;
  }
  if (received >= maxBytes) {
    await reader.cancel();
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function charsetIn(text: string): string | undefined {
  return /charset\s*=\s*["']?([\w-]+)/i.exec(text)?.[1];
}

/** Decodes with the header's charset, else one a <meta> declares near the start, else UTF-8. */
function decodeHtml(bytes: Uint8Array, contentType: string): string {
  const label = charsetIn(contentType) ?? charsetIn(String.fromCharCode(...bytes.subarray(0, 1024))) ?? "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/**
 * Fetches a page from the browser, without cookies, and reads its title,
 * description and cover. DOMParser never runs the page's scripts.
 */
export async function fetchPageMetadata(
  url: string,
  timeoutMs: number = FETCH_DETAILS_TIMEOUT_MS,
): Promise<FetchPageMetadataResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { credentials: "omit", redirect: "follow", signal: controller.signal });
    if (!response.ok) {
      return { status: "error", reason: "http" };
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!HTML_TYPES.has(contentType.split(";")[0]?.trim().toLowerCase() ?? "")) {
      return { status: "error", reason: "not-html" };
    }
    const html = decodeHtml(await readLimitedBytes(response, FETCH_DETAILS_MAX_BYTES), contentType);
    const pageUrl = response.url || url;
    const info = readPageInfo(new DOMParser().parseFromString(html, "text/html"), pageUrl);
    const metadata: PageMetadata = {
      title: info.ogTitle || info.title.trim(),
      description: info.metaDescription,
      imageUrl: normalizeCoverUrl(info.ogImage, pageUrl) ?? "",
    };
    if (!metadata.title && !metadata.description && !metadata.imageUrl) {
      return { status: "error", reason: "no-metadata" };
    }
    return { status: "ok", metadata };
  } catch {
    return { status: "error", reason: controller.signal.aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test test/page-metadata.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing form tests**

In `test/bookmark-form.test.tsx`, add `afterEach` to the `bun:test` import and `wait` to the `./helpers/dom-environment` import, then append:

```ts
describe("fetching details", () => {
  const page = '<html><head><title>Fetched title</title><meta property="og:description" content="Fetched description"><meta property="og:image" content="/cover.png"></head></html>';
  const accessRequests: string[][] = [];
  const fetchedUrls: string[] = [];
  let originalChrome: unknown;
  let originalFetch: unknown;
  let grantAccess = true;
  let responseType = "text/html; charset=utf-8";

  beforeEach(() => {
    originalChrome = Reflect.get(globalThis, "chrome");
    originalFetch = Reflect.get(globalThis, "fetch");
    accessRequests.length = 0;
    fetchedUrls.length = 0;
    grantAccess = true;
    responseType = "text/html; charset=utf-8";
    Reflect.set(globalThis, "chrome", {
      permissions: {
        request: async (permissions: { origins: string[] }) => {
          accessRequests.push(permissions.origins);
          return grantAccess;
        },
      },
    });
    Reflect.set(globalThis, "fetch", async (input: string) => {
      fetchedUrls.push(input);
      return new Response(page, { headers: { "content-type": responseType } });
    });
  });
  afterEach(() => {
    Reflect.set(globalThis, "chrome", originalChrome);
    Reflect.set(globalThis, "fetch", originalFetch);
  });

  async function fetchDetails(): Promise<void> {
    click(getByText("bookmarkForm_fetchDetails"));
    await wait(20);
  }
  const formCover = () => document.querySelector('[role="dialog"] [data-form-cover]');
  const stored = () => app.useBookmarksStore.getState().bookmarks.get("saved");

  test("the button waits for a web address", () => {
    open();
    const button = () => getByText("bookmarkForm_fetchDetails").closest("button");
    expect(button()?.disabled).toBe(true);
    typeInto(field("url"), "ftp://files.example.com/a");
    expect(button()?.disabled).toBe(true);
    typeInto(field("url"), "example.com");
    expect(button()?.disabled).toBe(false);
  });

  test("asks for the site during the click, then fills the empty fields and the cover", async () => {
    open();
    typeInto(field("url"), "example.com/article");
    click(getByText("bookmarkForm_fetchDetails"));
    expect(accessRequests).toEqual([["https://example.com/*"]]);
    await wait(20);

    expect(fetchedUrls).toEqual(["https://example.com/article"]);
    expect(field("title").value).toBe("Fetched title");
    expect(field("description").value).toBe("Fetched description");
    expect(formCover()?.getAttribute("src")).toBe("https://example.com/cover.png");
    await save();
    expect(added()?.imageUrl).toBe("https://example.com/cover.png");
  });

  test("offers fetched values for filled fields without overwriting them", async () => {
    open();
    fillRequired("My title", "https://example.com/article");
    typeInto(field("description"), "My description");
    await fetchDetails();

    expect(field("title").value).toBe("My title");
    expect(field("description").value).toBe("My description");
    click(getByText("bookmarkForm_useFetched[Fetched title]"));
    expect(field("title").value).toBe("Fetched title");
    expect(queryByText("bookmarkForm_useFetched[Fetched title]")).toBeNull();
    expect(queryByText("bookmarkForm_useFetched[Fetched description]")).not.toBeNull();
  });

  test("a refused site access says so and fetches nothing", async () => {
    grantAccess = false;
    open();
    typeInto(field("url"), "https://example.com/article");
    await fetchDetails();

    expect(getByText("bookmarkForm_fetchAccessDenied")).toBeTruthy();
    expect(fetchedUrls).toEqual([]);
    expect(field("title").value).toBe("");
  });

  test("a page that is not HTML shows an error and changes nothing", async () => {
    responseType = "application/pdf";
    open();
    typeInto(field("url"), "https://example.com/file.pdf");
    await fetchDetails();

    expect(getByText("bookmarkForm_fetchNotHtml")).toBeTruthy();
    expect(field("title").value).toBe("");
    expect(formCover()).toBeNull();
  });

  test("a cover fetched for one address is not saved under another", async () => {
    open();
    typeInto(field("url"), "https://example.com/article");
    await fetchDetails();
    typeInto(field("url"), "https://example.com/other");

    expect(formCover()).toBeNull();
    await save();
    expect(added()?.url).toBe("https://example.com/other");
    expect(added()?.imageUrl).toBe("");
  });

  test("an edit keeps the cover, and a new address clears it on save", async () => {
    act(() => seed([{ ...saved, imageUrl: "https://cdn.example.com/saved.png" }]));
    open({ bookmarkId: "saved" });
    expect(formCover()?.getAttribute("src")).toBe("https://cdn.example.com/saved.png");
    typeInto(field("title"), "Renamed");
    await save();
    expect(stored()?.imageUrl).toBe("https://cdn.example.com/saved.png");

    open({ bookmarkId: "saved" });
    typeInto(field("url"), "https://example.com/moved");
    await save();
    expect(stored()?.url).toBe("https://example.com/moved");
    expect(stored()?.imageUrl).toBe("");
  });

  test("details fetched for a new address keep its cover", async () => {
    act(() => seed([{ ...saved, imageUrl: "https://cdn.example.com/saved.png" }]));
    open({ bookmarkId: "saved" });
    typeInto(field("url"), "https://example.com/moved");
    await fetchDetails();
    await save();

    expect(stored()?.url).toBe("https://example.com/moved");
    expect(stored()?.imageUrl).toBe("https://example.com/cover.png");
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `bun test test/bookmark-form.test.tsx`
Expected: the existing tests pass and the "fetching details" tests FAIL — `No element with text "bookmarkForm_fetchDetails"`.

- [ ] **Step 7: Add the button, the suggestions and the cover to the form**

In `components/dashboard/shared/bookmark-form.tsx`:

1. Change the `lucide-react` import to `import { AlertCircle, ChevronDown, Loader2 } from "lucide-react";` and add:

   ```ts
   import { fetchPageMetadata, requestSiteAccess, type FetchPageMetadataError } from "@/lib/page-metadata";
   ```

2. Below `const NOTES_COUNTER_FROM = 9_000;` add:

   ```ts
   const FETCH_ERROR_KEYS: Record<FetchPageMetadataError, string> = {
     timeout: "bookmarkForm_fetchTimeout",
     network: "bookmarkForm_fetchFailed",
     http: "bookmarkForm_fetchFailed",
     "not-html": "bookmarkForm_fetchNotHtml",
     "no-metadata": "bookmarkForm_fetchNoMetadata",
   };
   ```

3. Below `normalizeBookmarkUrl`, add:

   ```ts
   /** The address "Fetch details" can request: the normalized URL, when it is http(s). */
   function fetchableUrl(input: string): string | null {
     const candidate = normalizeBookmarkUrl(input);
     if (!candidate) {
       return null;
     }
     const { protocol } = new URL(candidate);
     return protocol === "http:" || protocol === "https:" ? candidate : null;
   }
   ```

4. Below `const notesRef = React.useRef<HTMLTextAreaElement>(null);` add:

   ```ts
     const [coverUrl, setCoverUrl] = React.useState(bookmark?.imageUrl ?? "");
     // The address the cover belongs to; saving under another address clears the cover.
     const [coverUrlFor, setCoverUrlFor] = React.useState(bookmark?.url ?? "");
     const [fetched, setFetched] = React.useState<{ title: string; description: string } | null>(null);
     const [fetching, setFetching] = React.useState(false);
     const [fetchError, setFetchError] = React.useState("");
     // The address as typed, for a fetch that resolves after the user changed it.
     const urlRef = React.useRef(url);
   ```

5. Above `const saveNew = …`, add:

   ```ts
     // An untouched address is kept as it is, even if it predates the URL rule.
     const resolveSavedUrl = (input: string): string | null =>
       bookmark && input === bookmark.url ? bookmark.url : normalizeBookmarkUrl(input);
     /** The cover saved with an address: the form's cover when it belongs to that address, else none. */
     const coverForSave = (savedUrl: string): string => (savedUrl === coverUrlFor ? coverUrl : "");
     const shownCover = coverUrl && resolveSavedUrl(url) === coverUrlFor ? coverUrl : "";
     const titleSuggestion = fetched && fetched.title && fetched.title !== title ? fetched.title : "";
     const descriptionSuggestion = fetched && fetched.description && fetched.description !== description ? fetched.description : "";

     const handleFetchDetails = async () => {
       const target = fetchableUrl(url);
       if (!target || fetching) {
         return;
       }
       // Browsers grant permission requests only during the click, so this runs before any await.
       const access = requestSiteAccess(target);
       setFetching(true);
       setFetchError("");
       try {
         if (!(await access)) {
           setFetchError(t("bookmarkForm_fetchAccessDenied"));
           return;
         }
         const result = await fetchPageMetadata(target);
         if (fetchableUrl(urlRef.current) !== target) {
           return;
         }
         if (result.status === "error") {
           setFetchError(t(FETCH_ERROR_KEYS[result.reason]));
           return;
         }
         const { metadata } = result;
         setFetched({ title: metadata.title, description: metadata.description });
         // Empty fields take the fetched values; filled ones get a suggestion instead.
         setTitle((current) => (current.trim() ? current : metadata.title));
         setDescription((current) => (current.trim() ? current : metadata.description));
         if (metadata.title) {
           setErrors((current) => ({ ...current, title: undefined }));
         }
         if (metadata.imageUrl) {
           setCoverUrl(metadata.imageUrl);
           setCoverUrlFor(target);
         }
       } catch {
         setFetchError(t("bookmarkForm_fetchFailed"));
       } finally {
         setFetching(false);
       }
     };
   ```

6. In `saveNew`, add `imageUrl: coverForSave(savedUrl),` after `notes: notes.trim(),`.

7. In `saveEdit`, after `if (savedUrl !== original.url) { patch.url = savedUrl; }` add:

   ```ts
       const savedCover = coverForSave(savedUrl);
       if (savedCover !== (original.imageUrl ?? "")) { patch.imageUrl = savedCover; }
   ```

8. In `handleSave`, replace the comment and the `const savedUrl = …` line with `const savedUrl = resolveSavedUrl(url);`.

9. Below the title field's error paragraph (inside its `<Field>`), add:

   ```tsx
           {titleSuggestion && (
             <Button type="button" variant="link" size="sm" className="h-auto max-w-full justify-start p-0 text-xs" onClick={() => setTitle(titleSuggestion)}>
               <span className="truncate">{t("bookmarkForm_useFetched", [titleSuggestion])}</span>
             </Button>
           )}
   ```

10. Replace the address `<Input … />` with:

    ```tsx
            <div className="flex items-center gap-2">
              <Input
                id={`${idPrefix}-url`}
                name="url"
                value={url}
                className="flex-1"
                placeholder={t("bookmarkForm_urlPlaceholder")}
                aria-invalid={errors.url !== undefined}
                aria-describedby={errors.url ? `${idPrefix}-url-error` : undefined}
                onChange={(event) => {
                  setUrl(event.target.value);
                  urlRef.current = event.target.value;
                  setErrors((current) => ({ ...current, url: undefined }));
                }}
              />
              {shownCover && (
                <img
                  src={shownCover}
                  alt=""
                  data-form-cover=""
                  referrerPolicy="no-referrer"
                  className="h-9 w-[4.3rem] shrink-0 rounded-md border object-cover"
                />
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={fetching || fetchableUrl(url) === null}
                onClick={handleFetchDetails}
              >
                {fetching && <Loader2 className="size-4 animate-spin" />}
                {t(fetching ? "bookmarkForm_fetchingDetails" : "bookmarkForm_fetchDetails")}
              </Button>
            </div>
    ```

    and below the address error paragraph add:

    ```tsx
            {fetchError && <p role="alert" className="text-xs text-destructive">{fetchError}</p>}
    ```

11. Inside the description `<Field>`, below its `<Input … />`, add:

    ```tsx
            {descriptionSuggestion && (
              <Button type="button" variant="link" size="sm" className="h-auto max-w-full justify-start p-0 text-xs" onClick={() => setDescription(descriptionSuggestion)}>
                <span className="truncate">{t("bookmarkForm_useFetched", [descriptionSuggestion])}</span>
              </Button>
            )}
    ```

Add to `public/_locales/en/messages.json`, after `bookmarkForm_save`:

```json
  "bookmarkForm_fetchDetails": {
    "message": "Fetch details"
  },
  "bookmarkForm_fetchingDetails": {
    "message": "Fetching…"
  },
  "bookmarkForm_useFetched": {
    "message": "Use fetched: “$1”",
    "placeholders": {
      "1": {
        "content": "$1"
      }
    }
  },
  "bookmarkForm_fetchAccessDenied": {
    "message": "Allow access to this site to fetch its details."
  },
  "bookmarkForm_fetchTimeout": {
    "message": "The page took too long to respond."
  },
  "bookmarkForm_fetchFailed": {
    "message": "Couldn't load the page."
  },
  "bookmarkForm_fetchNotHtml": {
    "message": "This address isn't a web page."
  },
  "bookmarkForm_fetchNoMetadata": {
    "message": "The page has no title, description, or cover to use."
  },
```

and to `public/_locales/zh_CN/messages.json`, after `bookmarkForm_save`:

```json
  "bookmarkForm_fetchDetails": {
    "message": "获取详情"
  },
  "bookmarkForm_fetchingDetails": {
    "message": "正在获取…"
  },
  "bookmarkForm_useFetched": {
    "message": "使用获取的内容：“$1”",
    "placeholders": {
      "1": {
        "content": "$1"
      }
    }
  },
  "bookmarkForm_fetchAccessDenied": {
    "message": "允许访问该网站后才能获取详情。"
  },
  "bookmarkForm_fetchTimeout": {
    "message": "网页响应超时。"
  },
  "bookmarkForm_fetchFailed": {
    "message": "无法加载该网页。"
  },
  "bookmarkForm_fetchNotHtml": {
    "message": "该地址不是网页。"
  },
  "bookmarkForm_fetchNoMetadata": {
    "message": "该网页没有可用的标题、描述或封面。"
  },
```

- [ ] **Step 8: Run the tests and the type check**

Run: `bun test test/page-metadata.test.ts test/bookmark-form.test.tsx test/bookmark-form-duplicates.test.tsx test/favorites-bookmark-form.test.tsx && bun run compile`
Expected: PASS, and `tsc` reports no errors.

- [ ] **Step 9: Commit**

```bash
git add lib/page-metadata.ts components/dashboard/shared/bookmark-form.tsx public/_locales/en/messages.json public/_locales/zh_CN/messages.json test/page-metadata.test.ts test/bookmark-form.test.tsx
git commit -m "feat(bookmarks): fetch a page's details into the bookmark form

Fetch details asks for access to the one site during the click, loads
the page from the browser without cookies, and parses at most 2 MB of
HTML without running scripts. Empty fields are filled, filled ones get
a suggestion, and the fetched cover is saved only with the address it
was fetched for; any other new address clears the cover.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- lib/page-metadata.ts components/dashboard/shared/bookmark-form.tsx public/_locales/en/messages.json public/_locales/zh_CN/messages.json test/page-metadata.test.ts test/bookmark-form.test.tsx
```

---

### Task 8: Documentation and full verification

**Files:**
- Modify: `CLAUDE.md`, `ARCHITECTURE.md`, `lib/browser/data-collection-permissions.ts` (comments)

**Interfaces:**
- Consumes: everything above. Produces no code.

- [ ] **Step 1: Update the data-collection comments**

In `lib/browser/data-collection-permissions.ts`:

- In the comment above `FIREFOX_REQUIRED_DATA_COLLECTION`, after "…bookmark's domain in the URL." add the sentence "The large card view loads bookmark covers from the bookmarks' sites or their image hosts, which this category covers as well."
- In the comment above `FIREFOX_ACCOUNT_DATA_COLLECTION`, change "bookmark titles, descriptions and notes (websiteContent)" to "bookmark titles, descriptions, notes and cover URLs (websiteContent)".

- [ ] **Step 2: Update `CLAUDE.md`**

1. In the shared components list, after the `**Popover / Textarea**` entry, add:

   ```markdown
   - **BookmarkCover / BookmarkCoverPlaceholder** (`components/dashboard/bookmark-cover.tsx`) — 大卡片封面：1.91:1、`loading="lazy"`、`referrerPolicy="no-referrer"`、`alt=""`；无封面或加载失败时显示占位图（按 host 哈希取色，含 favicon 与 host，`aria-hidden`），加载失败的地址在本页面会话内不再重试
   ```

2. In the message table, replace the `GET_PAGE_INFO` row's last cell with:

   ```markdown
   保存书签前取页面信息（响应字段见注意事项「GET_PAGE_INFO 响应字段」），均经 `requestPageInfo(tabId, { allowInjection })`（`lib/page-info.ts`）发出：右键菜单保存（background）与 popup 打开时预取传 `allowInjection: true`，content script 未注册（未授予可选权限）时借 `activeTab` 用 `chrome.scripting.executeScript` 注入 `readPageInfo`；`tabs-store` 把窗口/标签组存为集合时逐个标签页请求，只问 content script。都失败（浏览器页面、PDF 等）时返回 null，调用方静默回退到 tab 默认值
   ```

3. In the paragraph below the table, replace its first sentence with: "类型定义见 `lib/messages.ts` 的 `ExtensionMessage`，但 `GET_PAGE_INFO` 不在其中：`requestPageInfo` 直接传 `{ type: "GET_PAGE_INFO" }` 字面量，响应结构为 `lib/page-info.ts` 的 `PageInfo`（缺失字段补为空字符串），`entrypoints/content.ts` 的处理函数把 `message` 声明为 `{ type?: string }`。"

4. At the end of the "视图偏好同步" bullet, add: "`viewMode` 取值 `grid`（小卡片，默认）与 `gallery`（大卡片，带封面）；旧版本存的 `list` 按未知值回退为 `grid`。"

5. Replace the "GET_PAGE_INFO 响应字段" bullet with:

   ```markdown
   - **GET_PAGE_INFO 响应字段**：content script 以 `readPageInfo()`（`lib/page-info.ts`；自包含，也供 `executeScript` 注入和「获取详情」解析使用）回应，返回 `{ title, url, selectedText, favicon, ogTitle, metaDescription, ogImage }`；`favicon` 与 `ogImage` 按页面（含 `<base>`）解析为绝对地址，`ogImage` 取 `og:image`，其次 `twitter:image`。三条保存路径（tabs-store `_saveTabsToCollectionHelper`、popup `handleSave`、background 右键菜单）均优先使用 `ogTitle` 作为书签标题、`metaDescription` 作为描述，并把 `normalizeCoverUrl(ogImage, url)`（`lib/bookmark-utils.ts`：只保留 http(s)、不超过 `MAX_BOOKMARK_IMAGE_URL_LENGTH = 2048`）存为 `Bookmark.imageUrl`；右键菜单保存链接（`info.linkUrl`）时不取当前页的封面。取不到页面信息时静默回退到 tab 默认值，没有封面。
   ```

6. After the "书签备注与编辑时间" bullet, add:

   ```markdown
   - **书签封面与获取详情**：`Bookmark.imageUrl`（缺省或 `""` 为无封面）同步为 `image_url`，规则与备注相同：推送总是携带，空字符串清除，`mergeFromServer` 取 `image_url ?? 本地 imageUrl ?? ""`，两处同步确认比较都包含该字段；批量操作不改封面。表单保存改动过的网址时清除封面，除非已为新网址「获取详情」。「获取详情」（`lib/page-metadata.ts` 的 `fetchPageMetadata`）：点击处理函数在任何 `await` 之前调用 `requestSiteAccess`（请求 `<scheme>://<host>/*`，已授予全站权限时直接通过）；`fetch` 不带 cookie、10 秒超时、最多读取 2 MB、只解析 `text/html` 与 `application/xhtml+xml`，用 `DOMParser` 解析（不执行脚本）；字符集取响应头，其次页面开头 1024 字节内的 `<meta charset>`。空字段直接填入，非空字段显示“使用获取的内容”建议，不静默覆盖。
   ```

7. In the "可选权限与动态注入" bullet, add a sub-bullet:

   ```markdown
       - **activeTab**：manifest 的 `permissions` 含 `activeTab`（Chromium 与 Firefox 构建，均无安装提示）。打开 popup（工具栏点击或保存快捷键）与点击右键菜单会授予当前标签页的临时访问权，未授予可选权限时也能注入 `readPageInfo` 读取页面信息。
   ```

8. In the "Firefox 数据收集声明与同意" bullet, change "书签标题、描述与备注都属于 `websiteContent`" to "书签标题、描述、备注与封面地址都属于 `websiteContent`", and after the `required: ["browsingActivity"]` clause's closing parenthesis add "；大卡片从书签站点（或其图片服务器）加载封面，同属 `browsingActivity`；「获取详情」由浏览器直接请求网页（不带 cookie），不经过 TabSlate 服务器，不涉及任何类别".

- [ ] **Step 3: Update `ARCHITECTURE.md`**

1. In the directory tree:
   - change the `entrypoints/popup/App.tsx` comment's "打开时调用 GET_PAGE_INFO 预取 ogTitle/metaDescription，保存时使用" to "打开时经 requestPageInfo（可借 activeTab 注入）预取 ogTitle/metaDescription/封面，保存时使用";
   - change the `content.ts` comment's "GET_PAGE_INFO 响应" to "以 readPageInfo() 回应 GET_PAGE_INFO";
   - change `bookmark-card.tsx   # 单个书签卡片/列表项` to `bookmark-card.tsx   # 书签小卡片与大卡片（大卡片带封面）` and add below it `│       ├── bookmark-cover.tsx  # 大卡片封面与占位图`;
   - under `├── lib/`, add `page-info.ts  # PageInfo、自包含的 readPageInfo()、requestPageInfo()（content script，必要时借 activeTab 注入）` and `page-metadata.ts  # 「获取详情」：requestSiteAccess、fetchPageMetadata`, following the neighbouring entries' indentation.
2. In the cross-process message table, replace the `GET_PAGE_INFO` row's last cell with: "保存书签前向目标标签页取页面信息，响应 `{ title, url, selectedText, favicon, ogTitle, metaDescription, ogImage }`，均经 `requestPageInfo` 发出：右键菜单保存（background）与 popup 打开时预取在 content script 不可用时借 `activeTab` 注入 `readPageInfo`；`tabs-store` 把窗口/标签组存为集合时逐个标签页请求，只问 content script；都失败时调用方静默回退到 tab 默认值".
3. Replace the paragraph that starts "`GET_PAGE_INFO` 是表中唯一不在 `ExtensionMessage` 里的消息" with: "`GET_PAGE_INFO` 是表中唯一不在 `ExtensionMessage` 里的消息：`requestPageInfo`（`lib/page-info.ts`）直接传 `{ type: "GET_PAGE_INFO" }` 字面量，响应结构为同一文件的 `PageInfo`，缺失字段补为空字符串；`content.ts` 的处理函数把 `message` 声明为 `{ type?: string }`。"
4. After the "`AddBookmarkResponse` 契约" bullet, add: "- **书签封面**：保存路径把页面的 `og:image`（其次 `twitter:image`）经 `normalizeCoverUrl` 存为 `Bookmark.imageUrl`，同步为 `image_url`（空字符串清除）。大卡片（`viewMode: "gallery"`）用 `BookmarkCover` 直接从站点加载封面，不带 referrer，失败显示占位图；小卡片不显示封面。书签表单的「获取详情」由浏览器直接请求网页，不经过服务端。"

- [ ] **Step 4: Run the whole extension suite and both builds**

```bash
bun test
bun run compile
bun run build:chrome
bun run build:firefox
grep -rl "__name(" .output/chrome-mv3 .output/firefox-mv3 || echo "no keepNames helpers"
```

Expected: every test passes, `tsc` reports no errors, both builds succeed, the generated manifests list `activeTab` (`grep -c activeTab .output/chrome-mv3/manifest.json .output/firefox-mv3/manifest.json` prints 1 for each), and the last command prints "no keepNames helpers". `executeScript` serializes `readPageInfo` from its source, so its compiled body must not call a module-level helper such as esbuild's `__name`; if the command lists files, open the chunk that contains `og:image` and check that `readPageInfo`'s body does not call it (other functions may).

- [ ] **Step 5: Run the server and Cloud suites again**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server && go vet ./... && go test ./...
cd /Users/lieutenant/Documents/github/TabSlate-Cloud && go build ./... && go test ./...
```

Expected: PASS (with `TEST_DATABASE_URL` set as in Prerequisites).

- [ ] **Step 6: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
git add CLAUDE.md ARCHITECTURE.md lib/browser/data-collection-permissions.ts
git commit -m "docs: document covers, large cards, activeTab and fetching details

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- CLAUDE.md ARCHITECTURE.md lib/browser/data-collection-permissions.ts
```

- [ ] **Step 7: Hand the manual checks to the user**

Report the branch states (extension `feat/bookmark-library-ux`, server `feat/bookmark-cover`; nothing pushed) and list the manual checks from the spec. Deployment order is TabSlate-server, then TabSlate-Cloud, then the extension.

1. In Chrome and in Firefox, without the optional all-sites permission, save a page that has an `og:image` from the toolbar popup, the save shortcut and the context menu; each bookmark shows its cover in the large card view.
2. Save a link from the context menu on a page with an `og:image`; the bookmark has no cover.
3. A site that blocks hotlinking shows the placeholder, and placeholders look right in dark mode.
4. Switch between small and large cards in the library and in Favorites; drag a large card onto a collection and check the drag preview.
5. In the bookmark form, "Fetch details" on a typed-in address asks for that one site (without the all-sites permission), fills empty fields, offers "Use fetched" for filled ones, and shows the cover thumbnail; changing the address hides the thumbnail.
6. A second signed-in profile shows the cover after sync, and clearing it on one device (editing the address) clears it on the other.
