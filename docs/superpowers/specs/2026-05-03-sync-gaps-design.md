# Sync Gaps Design — 2026-05-03

## Problem

Eight gaps where local data is never pushed to the server after sync was added:

1. Popup save bypasses syncEngine (writes directly to chrome.storage)
2. Context-menu save bypasses syncEngine (background.ts writes directly)
3. `addBookmarks` (batch window→collection save) never enqueues
4. `restoreFromArchive` never enqueues
5. `restoreFromTrash` never enqueues
6. `permanentlyDelete` sends wrong payload (isTrashed instead of deletedAt)
7. `deleteCollection` leaves orphaned bookmarks (invisible in UI, never moved)
8. Bookmark tags (local-only, never synced to server)

## Solution

**A类 fixes** — direct enqueue additions to store actions.

**B类 message passing** — popup/background use `chrome.tabs.sendMessage` to newtab (primary path); fallback to direct storage write when newtab closed.

**Startup seq=0 sweep** — `onPullSuccess` calls `sweepUnsynced()` on non-initial-push to catch any stranded seq=0 entities.

**Tags** — add `tag_ids text[]` column to bookmarks table; include in push/pull; `toServerBookmark` sends `tag_ids`; `mergeFromServer` reads it.

## Files Changed

- `store/bookmarks-store.ts` — A类 fixes, sweepUnsynced, reassignCollection, toServerBookmark+tags, mergeFromServer+tags
- `store/workspace-store.ts` — deleteCollection cascade, sweepUnsynced
- `lib/api.ts` — tag_ids on ServerBookmark
- `entrypoints/newtab/App.tsx` — onMessage listener, onPullSuccess sweep
- `entrypoints/popup/App.tsx` — message passing
- `entrypoints/background.ts` — message passing, generateId fix
- `TabSlate-server/db/schema.pg.sql` — tag_ids column migration
- `TabSlate-server/internal/model/model.go` — TagIDs field
- `TabSlate-server/internal/handler/sync.go` — push/pull tag_ids
