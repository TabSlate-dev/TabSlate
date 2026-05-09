# Saved Groups Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bidirectional sync for saved tab groups (SavedGroup + GroupTab) across devices using the existing push/pull/SSE infrastructure.

**Architecture:** Groups ride the existing `POST /sync/push` and `GET /sync/pull` endpoints. `SavedGroup` gains `seq` + `deletedAt` fields. `GroupTab` stays unchanged — tabs sync as a full snapshot bundled inside the parent group entity. Server stores groups in a new `groups` table and replaces tabs atomically per push.

**Tech Stack:** Go 1.21+ / pgx v5 / PostgreSQL 17 (server) · TypeScript / Zustand / WXT / Bun (client)

**Spec:** `docs/superpowers/specs/2026-05-08-saved-groups-sync-design.md`

---

## File Map

| File | Change |
|---|---|
| `TabSlate-server/internal/model/model.go` | Add `Group`, `GroupTab` structs; extend `SyncEntities` |
| `TabSlate-server/db/schema.pg.sql` | Add `groups` + `group_tabs` tables |
| `TabSlate-server/internal/handler/sync.go` | Extend Push + Pull handlers |
| `TabSlate/lib/api.ts` | Add `ServerGroup`, `ServerGroupTab`; extend `SyncEntities`, `SyncPushPayload` |
| `TabSlate/lib/sync-queue.ts` | Add `groups` to queue infrastructure |
| `TabSlate/lib/sync-engine.ts` | Update `forceSync` pulled count |
| `TabSlate/store/groups-store.ts` | Add sync fields, soft-delete, enqueue, `mergeFromServer`, `sweepUnsynced` |
| `TabSlate/entrypoints/newtab/App.tsx` | Wire `mergeFromServer` + `sweepUnsynced` for groups |

---

## Task 1 — Server: Add Group + GroupTab model types

**Files:**
- Modify: `TabSlate-server/internal/model/model.go`

- [ ] **Step 1: Add Group and GroupTab structs + extend SyncEntities**

Open `internal/model/model.go`. After the `Tag` struct (line 91), add:

```go
// Group is a saved tab group. Tabs sync as a snapshot — no individual tab seq.
type Group struct {
	ID        string     `json:"id"`
	UserID    string     `json:"user_id"`
	Name      string     `json:"name"`
	Color     string     `json:"color"`
	IsCompact bool       `json:"is_compact"`
	Seq       int64      `json:"seq"`
	DeletedAt *int64     `json:"deleted_at,omitempty"`
	CreatedAt int64      `json:"created_at"`
	UpdatedAt int64      `json:"updated_at"`
	Tabs      []GroupTab `json:"tabs"`
}

// GroupTab is a tab inside a saved group.
type GroupTab struct {
	ID       string `json:"id"`
	GroupID  string `json:"group_id"`
	Title    string `json:"title"`
	URL      string `json:"url"`
	Favicon  string `json:"favicon"`
	Position int    `json:"position"`
}
```

Then extend `SyncEntities` (around line 174) to add the `Groups` field:

```go
type SyncEntities struct {
	Workspaces  []Workspace  `json:"workspaces"`
	Collections []Collection `json:"collections"`
	Bookmarks   []Bookmark   `json:"bookmarks"`
	Tags        []Tag        `json:"tags"`
	Groups      []Group      `json:"groups"`
}
```

- [ ] **Step 2: Verify the server builds**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
go build ./...
```

Expected: no output (clean build).

- [ ] **Step 3: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
git add internal/model/model.go
git commit -m "feat(sync): add Group and GroupTab model types, extend SyncEntities"
```

---

## Task 2 — Server: Add DB schema

**Files:**
- Modify: `TabSlate-server/db/schema.pg.sql`

- [ ] **Step 1: Append groups and group_tabs tables to the schema**

At the end of `db/schema.pg.sql`, append:

```sql
-- Saved tab groups
CREATE TABLE IF NOT EXISTS groups (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL,
    is_compact BOOLEAN NOT NULL DEFAULT FALSE,
    seq        BIGINT NOT NULL DEFAULT 0,
    deleted_at BIGINT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_groups_user_seq ON groups (user_id, seq);

-- Tabs within a saved group (snapshot — no individual seq)
CREATE TABLE IF NOT EXISTS group_tabs (
    id       TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    title    TEXT NOT NULL,
    url      TEXT NOT NULL,
    favicon  TEXT NOT NULL,
    position INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_group_tabs_group ON group_tabs (group_id);
```

- [ ] **Step 2: Verify the server builds (schema is embedded via go:embed)**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
go build ./...
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
git add db/schema.pg.sql
git commit -m "feat(sync): add groups and group_tabs tables to schema"
```

---

## Task 3 — Server: Extend Push handler for groups

**Files:**
- Modify: `TabSlate-server/internal/handler/sync.go`

- [ ] **Step 1: Update entity count limit to include groups**

In `Push()`, find this block (around line 40–42):

```go
total := len(req.Entities.Workspaces) + len(req.Entities.Collections) +
    len(req.Entities.Bookmarks) + len(req.Entities.Tags)
```

Replace with:

```go
total := len(req.Entities.Workspaces) + len(req.Entities.Collections) +
    len(req.Entities.Bookmarks) + len(req.Entities.Tags) + len(req.Entities.Groups)
```

- [ ] **Step 2: Add groups upsert + tab snapshot logic**

In `Push()`, after the Tags section (after the `if res.RowsAffected() == 0` block for tags, before `if err := tx.Commit(ctx)`), add:

```go
// ── Groups ────────────────────────────────────────────────────────────────────
for _, g := range req.Entities.Groups {
    tag, err := tx.Exec(ctx, `
        INSERT INTO groups (id, user_id, name, color, is_compact, seq, deleted_at, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
        ON CONFLICT (id) DO UPDATE
          SET name=$3, color=$4, is_compact=$5, seq=$6, deleted_at=$7, updated_at=$8
        WHERE groups.user_id = $2 AND groups.updated_at < $8`,
        g.ID, userID, g.Name, g.Color, g.IsCompact, seq, g.DeletedAt, now)
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": "group upsert failed"})
        return
    }
    if tag.RowsAffected() == 0 {
        rejected = append(rejected, model.Rejected{ID: g.ID, Reason: "stale"})
        continue
    }
    // Atomically replace the tab snapshot for this group.
    if _, err := tx.Exec(ctx, `DELETE FROM group_tabs WHERE group_id = $1`, g.ID); err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": "group_tabs clear failed"})
        return
    }
    for _, t := range g.Tabs {
        if _, err := tx.Exec(ctx,
            `INSERT INTO group_tabs (id, group_id, title, url, favicon, position) VALUES ($1,$2,$3,$4,$5,$6)`,
            t.ID, g.ID, t.Title, t.URL, t.Favicon, t.Position); err != nil {
            c.JSON(http.StatusInternalServerError, gin.H{"error": "group_tab insert failed"})
            return
        }
    }
}
```

- [ ] **Step 3: Verify the server builds**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
go build ./...
go vet ./...
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
git add internal/handler/sync.go
git commit -m "feat(sync): extend Push handler to upsert groups with tab snapshot"
```

---

## Task 4 — Server: Extend Pull handler for groups

**Files:**
- Modify: `TabSlate-server/internal/handler/sync.go`

- [ ] **Step 1: Add groups query in Pull() and initialize empty Groups slice**

In `Pull()`, after the Tags nil-guard block (after `if resp.Entities.Tags == nil { ... }`), add the groups query and the `Groups` nil-guard:

```go
// Groups
grpRows, err := h.db.Query(ctx,
    `SELECT id, user_id, name, color, is_compact, seq, deleted_at, created_at, updated_at
     FROM groups WHERE user_id=$1 AND seq>$2 ORDER BY seq ASC`,
    userID, afterSeq)
if err != nil {
    c.JSON(http.StatusInternalServerError, gin.H{"error": "groups query failed"})
    return
}
defer grpRows.Close()

groupIdx := map[string]int{} // id → index in resp.Entities.Groups
for grpRows.Next() {
    var g model.Group
    if err := grpRows.Scan(&g.ID, &g.UserID, &g.Name, &g.Color, &g.IsCompact,
        &g.Seq, &g.DeletedAt, &g.CreatedAt, &g.UpdatedAt); err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": "group scan failed"})
        return
    }
    g.Tabs = []model.GroupTab{}
    groupIdx[g.ID] = len(resp.Entities.Groups)
    resp.Entities.Groups = append(resp.Entities.Groups, g)
}
if err := grpRows.Err(); err != nil {
    c.JSON(http.StatusInternalServerError, gin.H{"error": "groups iteration failed"})
    return
}

// Fetch tabs for all returned groups in one batch query.
if len(resp.Entities.Groups) > 0 {
    ids := make([]string, len(resp.Entities.Groups))
    for i, g := range resp.Entities.Groups {
        ids[i] = g.ID
    }
    tabRows, err := h.db.Query(ctx,
        `SELECT id, group_id, title, url, favicon, position
         FROM group_tabs WHERE group_id = ANY($1)`,
        ids)
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": "group_tabs query failed"})
        return
    }
    defer tabRows.Close()
    for tabRows.Next() {
        var t model.GroupTab
        if err := tabRows.Scan(&t.ID, &t.GroupID, &t.Title, &t.URL, &t.Favicon, &t.Position); err != nil {
            c.JSON(http.StatusInternalServerError, gin.H{"error": "group_tab scan failed"})
            return
        }
        if idx, ok := groupIdx[t.GroupID]; ok {
            resp.Entities.Groups[idx].Tabs = append(resp.Entities.Groups[idx].Tabs, t)
        }
    }
    if err := tabRows.Err(); err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": "group_tabs iteration failed"})
        return
    }
}

if resp.Entities.Groups == nil {
    resp.Entities.Groups = []model.Group{}
}
```

- [ ] **Step 2: Verify the server builds and passes vet**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
go build ./...
go vet ./...
```

Expected: no output.

- [ ] **Step 3: Run existing tests**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
go test ./...
```

Expected: all tests pass (PASS).

- [ ] **Step 4: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server
git add internal/handler/sync.go
git commit -m "feat(sync): extend Pull handler to return groups with tab snapshots"
```

---

## Task 5 — Client: Add API types

**Files:**
- Modify: `TabSlate/lib/api.ts`

- [ ] **Step 1: Add ServerGroupTab and ServerGroup interfaces**

In `lib/api.ts`, after the `ServerTag` interface (after line 85), add:

```ts
export interface ServerGroupTab {
  id: string;
  group_id: string;
  title: string;
  url: string;
  favicon: string;
  position: number;
}

export interface ServerGroup {
  id: string;
  user_id: string;
  name: string;
  color: string;
  is_compact: boolean;
  seq: number;
  deleted_at?: number;
  created_at: number;
  updated_at: number;
  tabs: ServerGroupTab[];
}
```

- [ ] **Step 2: Extend SyncEntities**

Find the `SyncEntities` interface (around line 87) and add the `groups` field:

```ts
export interface SyncEntities {
  workspaces: ServerWorkspace[];
  collections: ServerCollection[];
  bookmarks: ServerBookmark[];
  tags: ServerTag[];
  groups: ServerGroup[];
}
```

- [ ] **Step 3: Extend SyncPushPayload**

Find `SyncPushPayload` (around line 109) and add `groups`:

```ts
export interface SyncPushPayload {
  entities: {
    workspaces: object[];
    collections: object[];
    bookmarks: object[];
    tags: object[];
    groups: object[];
  };
}
```

- [ ] **Step 4: Type-check**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
bun run compile
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
git add lib/api.ts
git commit -m "feat(sync): add ServerGroup and ServerGroupTab API types"
```

---

## Task 6 — Client: Extend SyncQueue for groups

**Files:**
- Modify: `TabSlate/lib/sync-queue.ts`

- [ ] **Step 1: Add groups to QueuedEntities**

Find the `QueuedEntities` interface (lines 4–9) and add `groups`:

```ts
interface QueuedEntities {
  workspaces: Map<string, object>;
  collections: Map<string, object>;
  bookmarks: Map<string, object>;
  tags: Map<string, object>;
  groups: Map<string, object>;
}
```

- [ ] **Step 2: Update queue initialisation**

Find the `private queue: QueuedEntities = {` field (lines 20–25) and add `groups`:

```ts
private queue: QueuedEntities = {
  workspaces: new Map(),
  collections: new Map(),
  bookmarks: new Map(),
  tags: new Map(),
  groups: new Map(),
};
```

- [ ] **Step 3: Update enqueue signature and body**

Replace the `enqueue` method (lines 37–47):

```ts
enqueue(entities: Partial<{ workspaces: object[]; collections: object[]; bookmarks: object[]; tags: object[]; groups: object[] }>) {
  const set = <T extends { id: string }>(map: Map<string, object>, items?: T[]) => {
    items?.forEach(item => map.set(item.id, item));
  };
  set(this.queue.workspaces, entities.workspaces as Array<{ id: string }>);
  set(this.queue.collections, entities.collections as Array<{ id: string }>);
  set(this.queue.bookmarks, entities.bookmarks as Array<{ id: string }>);
  set(this.queue.tags, entities.tags as Array<{ id: string }>);
  set(this.queue.groups, entities.groups as Array<{ id: string }>);

  this.schedulePush(2000);
}
```

- [ ] **Step 4: Update isEmpty**

Replace the `isEmpty` method (lines 67–74):

```ts
isEmpty(): boolean {
  return (
    this.queue.workspaces.size === 0 &&
    this.queue.collections.size === 0 &&
    this.queue.bookmarks.size === 0 &&
    this.queue.tags.size === 0 &&
    this.queue.groups.size === 0
  );
}
```

- [ ] **Step 5: Update doPush snapshot and reset**

In `doPush` (lines 83–91), replace the snapshot building and queue reset:

```ts
const snapshot: SyncPushPayload = {
  entities: {
    workspaces: Array.from(this.queue.workspaces.values()),
    collections: Array.from(this.queue.collections.values()),
    bookmarks: Array.from(this.queue.bookmarks.values()),
    tags: Array.from(this.queue.tags.values()),
    groups: Array.from(this.queue.groups.values()),
  },
};
this.queue = { workspaces: new Map(), collections: new Map(), bookmarks: new Map(), tags: new Map(), groups: new Map() };
```

- [ ] **Step 6: Update re-enqueue on failure**

In the `catch` block (lines 99–102), add the groups re-enqueue after the tags line:

```ts
snapshot.entities.workspaces.forEach(e => this.queue.workspaces.set((e as { id: string }).id, e));
snapshot.entities.collections.forEach(e => this.queue.collections.set((e as { id: string }).id, e));
snapshot.entities.bookmarks.forEach(e => this.queue.bookmarks.set((e as { id: string }).id, e));
snapshot.entities.tags.forEach(e => this.queue.tags.set((e as { id: string }).id, e));
snapshot.entities.groups.forEach(e => this.queue.groups.set((e as { id: string }).id, e));
```

- [ ] **Step 7: Type-check**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
bun run compile
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
git add lib/sync-queue.ts
git commit -m "feat(sync): extend SyncQueue to support groups"
```

---

## Task 7 — Client: Add sync fields, soft-delete, and enqueue to groups-store

**Files:**
- Modify: `TabSlate/store/groups-store.ts`

- [ ] **Step 1: Add seq and deletedAt to SavedGroup**

Replace the `SavedGroup` interface (lines 16–22):

```ts
export interface SavedGroup {
  id: string;
  name: string;
  color: TabGroupColor;
  isCompact: boolean;
  createdAt: string;
  seq: number;        // 0 = never synced; >0 = server-confirmed
  deletedAt?: number; // unix ms; undefined = alive
}
```

- [ ] **Step 2: Add syncEngine import and toServerGroup helper**

After the existing imports (after line 5), add:

```ts
import { syncEngine } from "@/lib/sync-engine";
import type { SyncPullResponse } from "@/lib/api";
```

After the imports and before the `interface GroupsState` declaration, add:

```ts
function toServerGroup(g: SavedGroup, tabs: GroupTab[]): object {
  return {
    id: g.id,
    name: g.name,
    color: g.color,
    is_compact: g.isCompact,
    seq: g.seq,
    deleted_at: g.deletedAt ?? null,
    updated_at: Date.now(),
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

- [ ] **Step 3: Add mergeFromServer, sweepUnsynced, enqueueAllToSync to GroupsState interface**

Extend the `GroupsState` interface to add:

```ts
  mergeFromServer: (resp: SyncPullResponse) => void;
  sweepUnsynced: () => void;
  enqueueAllToSync: () => void;
```

- [ ] **Step 4: Update createGroup to stamp seq: 0 and enqueue**

Replace `createGroup` (lines 56–61):

```ts
createGroup: (name, color, isCompact) => {
  const id = generateId();
  const group: SavedGroup = { id, name, color, isCompact, createdAt: new Date().toISOString(), seq: 0 };
  syncEngine?.enqueue({ groups: [toServerGroup(group, [])] });
  set((state) => ({ groups: [...state.groups, group] }));
  idbPut("groups", group);
  return id;
},
```

- [ ] **Step 5: Update updateGroup to enqueue before set**

Replace `updateGroup` (lines 64–96):

```ts
updateGroup: (id, patch) => {
  const oldGroup = get().groups.find(g => g.id === id);
  const oldName = oldGroup?.name;

  if (oldGroup) {
    const updatedForSync = { ...oldGroup, ...patch };
    const tabs = get().groupTabs.filter(t => t.groupId === id);
    syncEngine?.enqueue({ groups: [toServerGroup(updatedForSync, tabs)] });
  }

  set((state) => ({
    groups: state.groups.map((g) =>
      g.id === id ? { ...g, ...patch } : g
    ),
  }));
  const updated = get().groups.find(g => g.id === id);
  if (updated) { idbPut("groups", updated); }

  // Sync to open Chrome tab groups
  if (oldName && (patch.name !== undefined || patch.color !== undefined)) {
    import("./tabs-store").then(({ useTabsStore }) => {
      const { tabGroups, fullTitles, updateGroup: updateChromeGroup } = useTabsStore.getState();
      const chromeGroup = tabGroups.find(g => (fullTitles[g.id] || g.title) === oldName);
      if (chromeGroup) {
        const chromePatch: any = {};
        if (patch.name !== undefined && (fullTitles[chromeGroup.id] || chromeGroup.title) !== patch.name) {
          chromePatch.title = patch.name;
        }
        if (patch.color !== undefined && chromeGroup.color !== patch.color) {
          chromePatch.color = patch.color;
        }
        if (Object.keys(chromePatch).length > 0) {
          updateChromeGroup(chromeGroup.id, chromePatch);
        }
      }
    });
  }
},
```

- [ ] **Step 6: Change deleteGroup to soft-delete**

Also update `GroupsState` interface: change `deleteGroup: (id: string) => Promise<void>` to `deleteGroup: (id: string) => void`.

Replace `deleteGroup` (lines 98–108):

```ts
deleteGroup: (id) => {
  const group = get().groups.find(g => g.id === id);
  if (!group) { return; }
  const tabs = get().groupTabs.filter(t => t.groupId === id);
  const deletedGroup = { ...group, deletedAt: Date.now() };
  syncEngine?.enqueue({ groups: [toServerGroup(deletedGroup, tabs)] });
  idbPut("groups", deletedGroup);
  for (const t of tabs) { idbDelete("group-tabs", t.id); }
  set((state) => ({
    groups: state.groups.map(g => g.id === id ? deletedGroup : g),
    groupTabs: state.groupTabs.filter(t => t.groupId !== id),
  }));
},
```

- [ ] **Step 7: Update addTabToGroup to enqueue**

Replace `addTabToGroup` (lines 110–122):

```ts
addTabToGroup: (groupId, tab) => {
  const { groupTabs, groups } = get();
  const existing = groupTabs.find(t => t.groupId === groupId && t.url === tab.url);
  if (existing) { return; }
  const position = groupTabs.filter(t => t.groupId === groupId).length;
  const newTab: GroupTab = { id: generateId(), groupId, ...tab, position };
  const newGroupTabs = [...groupTabs, newTab];
  const group = groups.find(g => g.id === groupId);
  if (group) {
    syncEngine?.enqueue({ groups: [toServerGroup(group, newGroupTabs.filter(t => t.groupId === groupId))] });
  }
  set(() => ({ groupTabs: newGroupTabs }));
  idbPut("group-tabs", newTab);
},
```

- [ ] **Step 8: Update removeTabFromGroup to enqueue**

Replace `removeTabFromGroup` (lines 124–129):

```ts
removeTabFromGroup: (tabId) => {
  const { groups, groupTabs } = get();
  const tab = groupTabs.find(t => t.id === tabId);
  if (tab) {
    const group = groups.find(g => g.id === tab.groupId);
    const remainingTabs = groupTabs.filter(t => t.id !== tabId && t.groupId === tab.groupId);
    if (group) {
      syncEngine?.enqueue({ groups: [toServerGroup(group, remainingTabs)] });
    }
  }
  idbDelete("group-tabs", tabId);
  set((state) => ({ groupTabs: state.groupTabs.filter(t => t.id !== tabId) }));
},
```

- [ ] **Step 9: Update moveTab to enqueue both affected groups**

Replace `moveTab` (lines 131–148):

```ts
moveTab: (tabId, toGroupId) => {
  const { groups, groupTabs } = get();
  const existingTab = groupTabs.find(t => t.id === tabId);
  if (!existingTab || existingTab.groupId === toGroupId) { return; }

  const fromGroupId = existingTab.groupId;
  const position = groupTabs.filter(t => t.groupId === toGroupId).length;
  const movedTab = { ...existingTab, groupId: toGroupId, position };
  const updatedTabs = groupTabs.map(t => t.id === tabId ? movedTab : t);

  const fromGroup = groups.find(g => g.id === fromGroupId);
  const toGroup = groups.find(g => g.id === toGroupId);
  const toEnqueue: object[] = [];
  if (fromGroup) { toEnqueue.push(toServerGroup(fromGroup, updatedTabs.filter(t => t.groupId === fromGroupId))); }
  if (toGroup) { toEnqueue.push(toServerGroup(toGroup, updatedTabs.filter(t => t.groupId === toGroupId))); }
  if (toEnqueue.length > 0) { syncEngine?.enqueue({ groups: toEnqueue }); }

  set(() => ({ groupTabs: updatedTabs }));
  idbPut("group-tabs", movedTab);
},
```

- [ ] **Step 10: Type-check**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
bun run compile
```

Expected: no errors. If `deleteGroup` callers use `await`, remove those awaits (the method is now synchronous).

- [ ] **Step 11: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
git add store/groups-store.ts
git commit -m "feat(sync): add seq/deletedAt to SavedGroup, soft-delete, enqueue on mutations"
```

---

## Task 8 — Client: Add mergeFromServer to groups-store

**Files:**
- Modify: `TabSlate/store/groups-store.ts`

- [ ] **Step 1: Add mergeFromServer implementation**

Add the `mergeFromServer` action inside the `create<GroupsState>()((set, get) => ({` object, after the `moveTab` action:

```ts
mergeFromServer: (resp) => {
  const serverGroups = resp.entities.groups;
  if (!serverGroups?.length) { return; }

  set((state) => {
    let groups = [...state.groups];
    let groupTabs = [...state.groupTabs];

    for (const sg of serverGroups) {
      const idx = groups.findIndex(g => g.id === sg.id);

      if (sg.deleted_at) {
        // Soft-deleted: update + keep in state so a future trash view can find it.
        const deletedGroup: SavedGroup = {
          id: sg.id,
          name: sg.name,
          color: sg.color as TabGroupColor,
          isCompact: sg.is_compact,
          createdAt: new Date(sg.created_at).toISOString(),
          seq: sg.seq,
          deletedAt: sg.deleted_at,
        };
        if (idx === -1) {
          groups.push(deletedGroup);
        } else {
          groups[idx] = deletedGroup;
        }
        groupTabs = groupTabs.filter(t => t.groupId !== sg.id);
      } else {
        // Active: LWW — server wins.
        const updatedGroup: SavedGroup = {
          id: sg.id,
          name: sg.name,
          color: sg.color as TabGroupColor,
          isCompact: sg.is_compact,
          createdAt: new Date(sg.created_at).toISOString(),
          seq: sg.seq,
        };
        if (idx === -1) {
          groups.push(updatedGroup);
        } else {
          groups[idx] = updatedGroup;
        }
        // Replace tab snapshot: remove old tabs then add server tabs.
        groupTabs = groupTabs.filter(t => t.groupId !== sg.id);
        for (const st of sg.tabs) {
          groupTabs.push({
            id: st.id,
            groupId: st.group_id,
            title: st.title,
            url: st.url,
            favicon: st.favicon,
            position: st.position,
          });
        }
      }
    }

    return { groups, groupTabs };
  });

  // Persist to IDB (fire-and-forget).
  const state = get();
  for (const sg of serverGroups) {
    const group = state.groups.find(g => g.id === sg.id);
    if (group) { idbPut("groups", group); }
    if (sg.deleted_at) {
      for (const t of sg.tabs ?? []) { idbDelete("group-tabs", t.id); }
    } else {
      for (const t of state.groupTabs.filter(t => t.groupId === sg.id)) {
        idbPut("group-tabs", t);
      }
    }
  }
},
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
bun run compile
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
git add store/groups-store.ts
git commit -m "feat(sync): add mergeFromServer to groups-store"
```

---

## Task 9 — Client: Add sweepUnsynced and enqueueAllToSync to groups-store

**Files:**
- Modify: `TabSlate/store/groups-store.ts`

- [ ] **Step 1: Add sweepUnsynced and enqueueAllToSync**

After `mergeFromServer`, add:

```ts
sweepUnsynced: () => {
  const { groups, groupTabs } = get();
  const unsynced = groups.filter(g => g.seq === 0);
  if (unsynced.length === 0) { return; }
  syncEngine?.enqueue({
    groups: unsynced.map(g => toServerGroup(g, groupTabs.filter(t => t.groupId === g.id))),
  });
},

enqueueAllToSync: () => {
  const { groups, groupTabs } = get();
  if (groups.length === 0) { return; }
  syncEngine?.enqueue({
    groups: groups.map(g => toServerGroup(g, groupTabs.filter(t => t.groupId === g.id))),
  });
},
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
bun run compile
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
git add store/groups-store.ts
git commit -m "feat(sync): add sweepUnsynced and enqueueAllToSync to groups-store"
```

---

## Task 10 — Client: Wire groups into App.tsx and sync-engine

**Files:**
- Modify: `TabSlate/entrypoints/newtab/App.tsx`
- Modify: `TabSlate/lib/sync-engine.ts`

- [ ] **Step 1: Update forceSync pulled count in sync-engine.ts**

In `sync-engine.ts`, find `forceSync` (around lines 86–92) and replace the pulled count:

```ts
pulled =
  resp.entities.workspaces.length +
  resp.entities.collections.length +
  resp.entities.bookmarks.length +
  resp.entities.tags.length +
  (resp.entities.groups?.length ?? 0);
```

- [ ] **Step 2: Add mergeGroups selector and ref in App.tsx SyncProvider**

In `SyncProvider` (around lines 133–146), add `mergeGroups` alongside the existing merge selectors:

```ts
const mergeGroups = useGroupsStore((s) => s.mergeFromServer);
```

After the `mergeBookmarksRef` ref:

```ts
const mergeGroupsRef = useRef(mergeGroups);
```

After the existing `useEffect` calls that keep refs current (the ones for mergeWorkspacesRef and mergeBookmarksRef), add:

```ts
useEffect(() => { mergeGroupsRef.current = mergeGroups; }, [mergeGroups]);
```

- [ ] **Step 3: Call mergeGroups in onPullSuccess**

In the `onPullSuccess` callback (around line 157–173), add `mergeGroupsRef.current(resp);` after `mergeBookmarksRef.current(resp);`:

```ts
(resp: SyncPullResponse) => {
  const needsInitialPush = localSeqRef.current === 0 && resp.server_seq === 0;
  mergeWorkspacesRef.current(resp);
  mergeBookmarksRef.current(resp);
  mergeGroupsRef.current(resp);   // NEW
  localSeqRef.current = resp.server_seq;
  setLocalSeqRef.current(resp.server_seq);
  if (needsInitialPush) {
    useWorkspaceStore.getState().enqueueAllToSync();
    useBookmarksStore.getState().enqueueAllToSync();
    useGroupsStore.getState().enqueueAllToSync();  // NEW
    if (useWorkspaceStore.getState().workspaces.length === 0) {
      useWorkspaceStore.getState().createWorkspace("My Workspace", "blue");
    }
  } else {
    useWorkspaceStore.getState().sweepUnsynced();
    useBookmarksStore.getState().sweepUnsynced();
    useGroupsStore.getState().sweepUnsynced();  // NEW
  }
},
```

- [ ] **Step 4: Type-check**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
bun run compile
```

Expected: no errors.

- [ ] **Step 5: Build check**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
bun run build
```

Expected: build succeeds with no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/lieutenant/Documents/github/TabSlate
git add entrypoints/newtab/App.tsx lib/sync-engine.ts
git commit -m "feat(sync): wire groups mergeFromServer and sweepUnsynced into SyncProvider"
```

---

## Verification Checklist

After all tasks complete:

- [ ] `go build ./...` clean in TabSlate-server
- [ ] `go test ./...` passes in TabSlate-server
- [ ] `bun run compile` clean in TabSlate
- [ ] `bun run build` succeeds in TabSlate
- [ ] Manual smoke test: create a group on device A → appears on device B after sync
- [ ] Manual smoke test: delete a group on device A → disappears on device B after sync
- [ ] Manual smoke test: add a tab to a group on device A → tab appears on device B after sync
