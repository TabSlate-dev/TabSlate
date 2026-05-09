# Groups Workspace Isolation Design

## Goal

Add `workspaceId` to saved groups so each group belongs to exactly one workspace. Groups panel and sidebar show only the active workspace's groups; trash view filters trashed groups by workspace. No backward compatibility for groups without a workspace ID.

## Architecture

Add a nullable `workspace_id` column to the server `groups` table and a required `workspaceId: string` field to the frontend `SavedGroup` interface. The field flows through the existing push/pull sync cycle unchanged. Null-workspace groups (legacy rows) are purged from IDB on encounter and never enter Zustand state. `deleteWorkspace` soft-deletes all its groups before removing the workspace record, so the server's `ON DELETE SET NULL` is never reached in normal operation.

## Tech Stack

TypeScript · React · Zustand · IndexedDB · Go · PostgreSQL

---

## Section 1: Data Model

### Frontend — `SavedGroup` (`store/groups-store.ts`)

```ts
export interface SavedGroup {
  id: string;
  name: string;
  color: TabGroupColor;
  isCompact: boolean;
  createdAt: string;
  seq: number;
  deletedAt?: number;
  workspaceId: string;   // required; always set on create
}
```

### Server — `model.go`

```go
type Group struct {
    ID          string     `json:"id"`
    UserID      string     `json:"user_id"`
    Name        string     `json:"name"`
    Color       string     `json:"color"`
    IsCompact   bool       `json:"is_compact"`
    Seq         int64      `json:"seq"`
    DeletedAt   *int64     `json:"deleted_at,omitempty"`
    CreatedAt   int64      `json:"created_at"`
    UpdatedAt   int64      `json:"updated_at"`
    WorkspaceID *string    `json:"workspace_id"`
    Tabs        []GroupTab `json:"tabs"`
}
```

### Server — schema migration (`db/schema.pg.sql`)

Appended as an idempotent block at the end of the file:

```sql
DO $$ BEGIN
  ALTER TABLE groups ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
```

`ON DELETE SET NULL` is a safety net only. Normal workspace deletion always tombstones groups first via client logic (see Section 5).

---

## Section 2: Frontend Store Changes (`store/groups-store.ts`)

### `createGroup` signature

```ts
createGroup: (name: string, color: TabGroupColor, isCompact: boolean, workspaceId: string) => string;
```

Group object construction:

```ts
const group: SavedGroup = {
  id, name, color, isCompact,
  createdAt: new Date().toISOString(),
  seq: 0,
  workspaceId,
};
```

### `toServerGroup`

Add `workspace_id` to the push payload:

```ts
function toServerGroup(g: SavedGroup, tabs: GroupTab[]): object {
  return {
    id: g.id,
    name: g.name,
    color: g.color,
    is_compact: g.isCompact,
    seq: g.seq,
    deleted_at: g.deletedAt ?? null,
    created_at: new Date(g.createdAt).getTime(),
    updated_at: Date.now(),
    workspace_id: g.workspaceId,
    tabs: tabs.map(t => ({
      id: t.id,
      group_id: t.groupId,
      title: t.title,
      url: t.url,
      favicon: t.favicon,
      position: t.position,
    })),
  };
}
```

### `hydrate`

Filter and purge null-workspace groups from IDB:

```ts
hydrate: async () => {
  const [allGroups, groupTabs] = await Promise.all([
    idbGetAll<SavedGroup>("groups"),
    idbGetAll<GroupTab>("group-tabs"),
  ]);
  const validGroups = allGroups.filter(g => {
    if (!g.workspaceId) {
      idbDelete("groups", g.id);
      return false;
    }
    return true;
  });
  set({ groups: validGroups, groupTabs, _hydrated: true });
},
```

### `mergeFromServer`

Skip and purge null-workspace groups:

```ts
// At the top of the for loop over serverGroups:
if (sg.workspace_id === null || sg.workspace_id === undefined) {
  idbDelete("groups", sg.id);
  groups = groups.filter(g => g.id !== sg.id);
  continue;
}
```

When constructing `updatedGroup` and `deletedGroup`, read `workspaceId`:

```ts
const updatedGroup: SavedGroup = {
  id: sg.id,
  name: sg.name,
  color: sg.color as TabGroupColor,
  isCompact: sg.is_compact,
  createdAt: new Date(sg.created_at).toISOString(),
  seq: sg.seq,
  workspaceId: sg.workspace_id,
};

const deletedGroup: SavedGroup = {
  id: sg.id,
  name: sg.name,
  color: sg.color as TabGroupColor,
  isCompact: sg.is_compact,
  createdAt: new Date(sg.created_at).toISOString(),
  seq: sg.seq,
  deletedAt: sg.deleted_at,
  workspaceId: sg.workspace_id,
};
```

---

## Section 3: Frontend UI Changes

### `createGroup` callsites

All six callsites must pass `activeWorkspaceId` as the fourth argument.

**Imperative callsites** (use `useGroupsStore.getState()`) — add `useWorkspaceStore.getState().activeWorkspaceId`:

| File | Line |
|---|---|
| `components/dashboard/tabs-dnd-provider.tsx` | ~201 |
| `components/dashboard/sidebar/index.tsx` | ~517 |
| `components/dashboard/tabs-panel/group-card.tsx` | ~139 |

**Reactive callsites** (use `useGroupsStore(s => s.createGroup)`) — add selector `const activeWorkspaceId = useWorkspaceStore(s => s.activeWorkspaceId)`:

| File | Line |
|---|---|
| `components/dashboard/trash-content.tsx` | ~309, ~648 |
| `components/dashboard/groups-panel/create-group-bar.tsx` | ~17 |

### Filtering changes

| Component | Existing filter | New filter |
|---|---|---|
| `GroupsPanel` | `!g.deletedAt` | `!g.deletedAt && g.workspaceId === activeWorkspaceId` |
| `Sidebar` groups list | `!g.deletedAt` | `!g.deletedAt && g.workspaceId === activeWorkspaceId` |
| `TrashContent` trashedGroups | `!!g.deletedAt` | `!!g.deletedAt && g.workspaceId === activeWorkspaceId` |

Each component reads `activeWorkspaceId` via `useWorkspaceStore(s => s.activeWorkspaceId)` and includes it in the relevant `useMemo` dependency array.

### `deleteWorkspace` (`store/workspace-store.ts`)

Before removing the workspace record, soft-delete all active groups in that workspace:

```ts
// At the start of deleteWorkspace(id):
const { groups, deleteGroup } = useGroupsStore.getState();
for (const g of groups) {
  if (g.workspaceId === id && !g.deletedAt) {
    deleteGroup(g.id);
  }
}
// ...existing workspace deletion logic follows
```

---

## Section 4: Server Changes

### `internal/handler/sync.go` — push handler

Update the group upsert query to include `workspace_id` (column 9):

```go
tag, err := tx.Exec(ctx, `
    INSERT INTO groups (id, user_id, name, color, is_compact, seq, deleted_at, created_at, updated_at, workspace_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9)
    ON CONFLICT (id) DO UPDATE
      SET name=$3, color=$4, is_compact=$5, seq=$6, deleted_at=$7, updated_at=$8, workspace_id=$9
    WHERE groups.user_id = $2 AND groups.updated_at < $8`,
    g.ID, userID, g.Name, g.Color, g.IsCompact, seq, g.DeletedAt, now, g.WorkspaceID)
```

`g.WorkspaceID` is `*string`; Go/pgx sends `nil` as SQL `NULL`.

### `internal/handler/sync.go` — pull handler

Add `workspace_id` to SELECT and Scan:

```go
grpRows, err := h.db.Query(ctx,
    `SELECT id, user_id, name, color, is_compact, seq, deleted_at, created_at, updated_at, workspace_id
     FROM groups WHERE user_id=$1 AND seq>$2 ORDER BY seq ASC`,
    userID, afterSeq)

// Scan:
grpRows.Scan(&g.ID, &g.UserID, &g.Name, &g.Color, &g.IsCompact,
    &g.Seq, &g.DeletedAt, &g.CreatedAt, &g.UpdatedAt, &g.WorkspaceID)
```

---

## Section 5: Sync Behavior & Null Handling

- **Push**: `workspace_id` is included in every group payload. Old clients pushing without this field send `null`; the server stores `NULL`, making those groups invisible on updated clients.
- **Pull**: `workspace_id` is returned for every group. `null` → client purges from IDB and state (see Section 2).
- **`sweepUnsynced`**: only processes `seq === 0` groups. Null-workspace groups never reach state, so they can never be re-pushed inadvertently.
- **`enqueueAllToSync`**: all groups in state have a valid `workspaceId` at this point; null-workspace groups were purged at hydration.
- **Workspace deletion order**: `deleteWorkspace` soft-deletes all active groups in the workspace first → each `deleteGroup` call enqueues a tombstone (with valid `workspace_id`) to sync → server receives `deleted_at` set, not a null workspace → `ON DELETE SET NULL` never fires in normal operation.
