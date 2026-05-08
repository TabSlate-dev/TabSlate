# Saved Groups Sync — Design Spec

**Date:** 2026-05-08
**Scope:** Full-stack (TabSlate Chrome extension + TabSlate-server)
**Approach:** Extend existing sync pipeline (Option A)

---

## Summary

Saved groups (`SavedGroup` + `GroupTab`) are currently client-only, living in IndexedDB with no sync fields. This spec adds them to the existing sync pipeline so groups are synced across devices in real time, using the same SyncQueue / SSE / pull-cursor mechanism as workspaces, collections, bookmarks, and tags.

Groups support two states: **active** and **trashed** (soft-delete via `deletedAt`). No archived state.

Tab lists sync as a **snapshot** — on each push the server atomically replaces all tabs for a group. Individual `GroupTab` rows carry no `seq` or `deletedAt`.

---

## Data Models

### Client (`lib/types.ts` + `store/groups-store.ts`)

```ts
interface SavedGroup {
  id: string;
  name: string;
  color: TabGroupColor;
  isCompact: boolean;
  createdAt: string;       // existing — kept as string locally
  seq: number;             // NEW: 0 = never synced; >0 = server-confirmed
  deletedAt?: number;      // NEW: unix ms; undefined = alive
}

// GroupTab — unchanged, no sync fields
interface GroupTab {
  id: string;
  groupId: string;
  title: string;
  url: string;
  favicon: string;
  position: number;
}
```

### Server types (`lib/api.ts`)

```ts
interface ServerGroup {
  id: string;
  user_id: string;
  name: string;
  color: string;
  is_compact: boolean;
  seq: number;
  deleted_at?: number;
  created_at: number;      // unix ms
  updated_at: number;      // unix ms
  tabs: ServerGroupTab[];  // bundled on pull; sent on push
}

interface ServerGroupTab {
  id: string;
  group_id: string;
  title: string;
  url: string;
  favicon: string;
  position: number;
}
```

---

## API Contract

No new endpoints. Groups ride the existing push/pull routes.

### Push — `POST /sync/push`

`SyncPushPayload.entities` gains:
```ts
groups: ServerGroup[]; // each includes full tabs[]
```

### Pull — `GET /sync/pull?after_seq=N`

`SyncEntities` gains:
```ts
groups: ServerGroup[]; // each includes full tabs[]; includes soft-deleted groups
```

Soft-deleted groups (`deleted_at` set) are included in pull results so clients remove them locally — same pattern as all other entities.

---

## Client-side Store (`store/groups-store.ts`)

### 1. `toServerGroup(g, tabs)` helper

Converts a local `SavedGroup` + its `GroupTab[]` to `ServerGroup` shape for the push payload:

- `createdAt` (string) → `created_at` via `new Date(g.createdAt).getTime()`
- `deletedAt` → `deleted_at ?? null`
- `isCompact` → `is_compact`
- `tabs` mapped to `ServerGroupTab` shape

### 2. Enqueue after every mutation

`syncEngine?.enqueue({ groups: [toServerGroup(group, tabs)] })` called **before** `set()` in:
- `createGroup`
- `updateGroup`
- `deleteGroup` (sets `deletedAt = Date.now()`, soft-delete)
- `addTabToGroup`
- `removeTabFromGroup`
- `reorderTabs`

### 3. `mergeFromServer(resp)`

Called by the sync engine after a pull. For each `ServerGroup` in `resp.entities.groups`:

| Condition | Action |
|---|---|
| `deleted_at` set | Update + keep in Zustand state with `deletedAt` set; `idbPut("groups", …)`; `idbDelete("group-tabs", tabId)` for all tabs |
| Found locally | LWW: server wins — update Zustand + `idbPut("groups", …)` + replace tabs in IDB |
| Not found locally | Insert into Zustand + `idbPut("groups", …)` + `idbPut("group-tabs", …)` for all tabs |

Soft-deleted groups must be **updated + kept** in the `groups` array (not removed), so a future trash view can find them via `groups.filter(g => !!g.deletedAt)` — mirrors the collection pattern.

### 4. `sweepUnsynced()`

Re-enqueues all groups where `seq === 0` (created offline or before sync). Called from `App.tsx` `onPullSuccess` alongside the existing workspace/bookmark sweep.

---

## Server-side (`TabSlate-server`)

### DB Schema

```sql
CREATE TABLE groups (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL,
  is_compact BOOLEAN NOT NULL DEFAULT FALSE,
  seq        BIGINT NOT NULL DEFAULT 0,
  deleted_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX idx_groups_user_seq ON groups (user_id, seq);

CREATE TABLE group_tabs (
  id       TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  title    TEXT NOT NULL,
  url      TEXT NOT NULL,
  favicon  TEXT NOT NULL,
  position INTEGER NOT NULL
);
CREATE INDEX idx_group_tabs_group ON group_tabs (group_id);
```

### Push Handler (`POST /sync/push`)

For each group in `entities.groups`:
1. Upsert `groups` row with LWW: `INSERT … ON CONFLICT DO UPDATE SET … WHERE updated_at < excluded.updated_at`
2. Atomically replace tabs: `DELETE FROM group_tabs WHERE group_id = $id`, then bulk `INSERT` new rows
3. Assign new `seq` from global sequence counter (same mechanism as other entities)
4. Broadcast `{seq: N}` to SSE hub so other devices pull

### Pull Handler (`GET /sync/pull`)

```sql
SELECT g.*, COALESCE(json_agg(gt.*) FILTER (WHERE gt.id IS NOT NULL), '[]') AS tabs
FROM groups g
LEFT JOIN group_tabs gt ON gt.group_id = g.id
WHERE g.user_id = $user_id AND g.seq > $after_seq
GROUP BY g.id
```

Returns soft-deleted groups so clients can remove them locally.

---

## Error Handling & Edge Cases

**Offline / push failure** — SyncQueue's existing retry-with-backoff covers this. `sweepUnsynced()` re-enqueues `seq === 0` groups on next successful pull.

**Deleted group re-appears on pull** — `mergeFromServer` updates + keeps the local record with `deletedAt` set (mirrors collection pattern).

**Concurrent tab edits on two devices** — LWW on `updated_at` at the group level. The losing device receives the winner's full tab snapshot on next pull and overwrites locally.

**`createdAt` round-trip** — stored as unix ms (`BIGINT`) on server; converted from/to the client's string representation in `toServerGroup()` / `mergeFromServer()`.

**UUID collisions** — client-generated UUIDs; collision probability negligible, no special handling.
