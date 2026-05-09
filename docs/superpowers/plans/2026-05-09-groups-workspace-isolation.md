# Groups Workspace Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `workspaceId` to saved groups so each group belongs to one workspace; groups panel, sidebar, and trash view filter by active workspace.

**Architecture:** Add `workspace_id` (nullable) to the server `groups` table and `workspaceId: string` (required) to the frontend `SavedGroup` interface. The field flows through the existing push/pull sync cycle. Null-workspace groups (legacy rows with no `workspace_id`) are purged from IDB on encounter and never enter Zustand state. `deleteWorkspace` soft-deletes its groups before removing the workspace record.

**Tech Stack:** TypeScript · React · Zustand · IndexedDB · Go · PostgreSQL 17

---

## File Map

| File | Change |
|---|---|
| `TabSlate-server/internal/model/model.go` | Add `WorkspaceID *string` to `Group` struct |
| `TabSlate-server/db/schema.pg.sql` | Append idempotent `ALTER TABLE groups ADD COLUMN workspace_id` migration |
| `TabSlate-server/internal/handler/sync.go` | Push: add `workspace_id` to INSERT/UPDATE. Pull: add to SELECT/Scan |
| `store/groups-store.ts` | `SavedGroup` interface, `toServerGroup`, `createGroup`, `hydrate`, `mergeFromServer` |
| `store/workspace-store.ts` | `deleteWorkspace`: soft-delete groups before removing workspace |
| `components/dashboard/groups-panel/create-group-bar.tsx` | Pass `activeWorkspaceId` to `createGroup` |
| `components/dashboard/tabs-panel/group-card.tsx` | Pass `activeWorkspaceId` to `createGroup` |
| `components/dashboard/tabs-dnd-provider.tsx` | Pass `activeWorkspaceId` to `createGroup` |
| `components/dashboard/sidebar/index.tsx` | Pass `activeWorkspaceId` to `createGroup`; filter groups useMemo |
| `components/dashboard/trash-content.tsx` | Pass `activeWorkspaceId` to `createGroup`; filter `trashedGroups` useMemo |
| `components/dashboard/groups-panel/index.tsx` | Filter `activeGroups` by `activeWorkspaceId` |

---

## Task 1: Server — Group Struct + Schema Migration

**Files:**
- Modify: `TabSlate-server/internal/model/model.go`
- Modify: `TabSlate-server/db/schema.pg.sql`

- [ ] **Step 1: Add `WorkspaceID` to the `Group` struct**

In `TabSlate-server/internal/model/model.go`, the current `Group` struct ends at line 106. Add `WorkspaceID` between `UpdatedAt` and `Tabs`:

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

- [ ] **Step 2: Append the schema migration block**

At the very end of `TabSlate-server/db/schema.pg.sql`, after the `idx_group_tabs_group` index, append:

```sql

-- Add workspace_id to groups (idempotent)
DO $$ BEGIN
  ALTER TABLE groups ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server && go build ./... && go vet ./...
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add internal/model/model.go db/schema.pg.sql
git commit -m "feat(groups): add workspace_id to Group struct and schema migration"
```

---

## Task 2: Server — Sync Push Handler

**Files:**
- Modify: `TabSlate-server/internal/handler/sync.go` (push section, around line 179)

The current INSERT at line 179 has 8 columns and 8 parameters. Add `workspace_id` as the 9th.

- [ ] **Step 1: Update the group upsert query**

Replace the `tx.Exec` call for group upsert (lines 179–185) with:

```go
tag, err := tx.Exec(ctx, `
    INSERT INTO groups (id, user_id, name, color, is_compact, seq, deleted_at, created_at, updated_at, workspace_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9)
    ON CONFLICT (id) DO UPDATE
      SET name=$3, color=$4, is_compact=$5, seq=$6, deleted_at=$7, updated_at=$8, workspace_id=$9
    WHERE groups.user_id = $2 AND groups.updated_at < $8`,
    g.ID, userID, g.Name, g.Color, g.IsCompact, seq, g.DeletedAt, now, g.WorkspaceID)
```

`g.WorkspaceID` is `*string`; pgx sends `nil` as SQL `NULL`.

- [ ] **Step 2: Verify build**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server && go build ./... && go vet ./...
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add internal/handler/sync.go
git commit -m "feat(groups): include workspace_id in sync push upsert"
```

---

## Task 3: Server — Sync Pull Handler

**Files:**
- Modify: `TabSlate-server/internal/handler/sync.go` (pull section, around line 350)

- [ ] **Step 1: Add `workspace_id` to the groups SELECT**

Replace the `h.db.Query` call for groups (lines 350–353) with:

```go
grpRows, err := h.db.Query(ctx,
    `SELECT id, user_id, name, color, is_compact, seq, deleted_at, created_at, updated_at, workspace_id
     FROM groups WHERE user_id=$1 AND seq>$2 ORDER BY seq ASC`,
    userID, afterSeq)
```

- [ ] **Step 2: Add `&g.WorkspaceID` to the Scan call**

Replace the `grpRows.Scan` call (lines 363–364) with:

```go
if err := grpRows.Scan(&g.ID, &g.UserID, &g.Name, &g.Color, &g.IsCompact,
    &g.Seq, &g.DeletedAt, &g.CreatedAt, &g.UpdatedAt, &g.WorkspaceID); err != nil {
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/lieutenant/Documents/github/TabSlate-server && go build ./... && go vet ./...
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add internal/handler/sync.go
git commit -m "feat(groups): include workspace_id in sync pull response"
```

---

## Task 4: Frontend Store — SavedGroup + createGroup + toServerGroup + hydrate + mergeFromServer

**Files:**
- Modify: `store/groups-store.ts`

All changes are in this one file. Make them all before compiling since they're tightly coupled — adding `workspaceId` to `SavedGroup` causes compile errors in `createGroup`, `hydrate`, and `mergeFromServer` until all are updated.

- [ ] **Step 1: Add `workspaceId` to `SavedGroup` interface (line 18)**

```ts
export interface SavedGroup {
  id: string;
  name: string;
  color: TabGroupColor;
  isCompact: boolean;
  createdAt: string;
  seq: number;        // 0 = never synced; >0 = server-confirmed
  deletedAt?: number; // unix ms; undefined = alive
  workspaceId: string;
}
```

- [ ] **Step 2: Add `workspace_id` to `toServerGroup` (line 28)**

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

- [ ] **Step 3: Update `createGroup` signature in `GroupsState` interface (line 56)**

```ts
createGroup: (name: string, color: TabGroupColor, isCompact: boolean, workspaceId: string) => string;
```

- [ ] **Step 4: Update `createGroup` implementation body (line 89)**

```ts
createGroup: (name, color, isCompact, workspaceId) => {
  const id = generateId();
  const group: SavedGroup = { id, name, color, isCompact, createdAt: new Date().toISOString(), seq: 0, workspaceId };
  syncEngine?.enqueue({ groups: [toServerGroup(group, [])] });
  set((state) => ({ groups: [...state.groups, group] }));
  idbPut("groups", group);
  return id;
},
```

- [ ] **Step 5: Update `hydrate` to filter and purge null-workspace groups (line 81)**

```ts
hydrate: async () => {
  const [allGroups, groupTabs] = await Promise.all([
    idbGetAll<SavedGroup>("groups"),
    idbGetAll<GroupTab>("group-tabs"),
  ]);
  const groups = allGroups.filter(g => {
    if (!g.workspaceId) {
      idbDelete("groups", g.id);
      return false;
    }
    return true;
  });
  set({ groups, groupTabs, _hydrated: true });
},
```

- [ ] **Step 6: Update `mergeFromServer` to skip/purge null-workspace groups and populate `workspaceId`**

The full updated `mergeFromServer` method (replace lines 237–328):

```ts
mergeFromServer: (resp) => {
  const serverGroups = resp.entities.groups;
  if (!serverGroups?.length) { return; }

  // Collect null-workspace IDs before entering the set() updater (keep updater pure).
  const nullWorkspaceIds = new Set(
    serverGroups
      .filter(sg => sg.workspace_id === null || sg.workspace_id === undefined)
      .map(sg => sg.id)
  );

  set((state) => {
    let groups = [...state.groups];
    let groupTabs = [...state.groupTabs];

    for (const sg of serverGroups) {
      const idx = groups.findIndex(g => g.id === sg.id);

      if (nullWorkspaceIds.has(sg.id)) {
        // Purge from state; IDB deletion happens after set() returns.
        groups = groups.filter(g => g.id !== sg.id);
        continue;
      }

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
          workspaceId: sg.workspace_id,
        };
        if (idx === -1) {
          groups.push(deletedGroup);
        } else {
          groups[idx] = deletedGroup;
        }
        // Server always cascade-deletes group_tabs on push, so the pull response
        // returns tabs: [] for soft-deleted groups. Preserve local tabs so the
        // trash view can still show them; only replace if server sends real data.
        if (sg.tabs.length > 0) {
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
      } else {
        // Active: LWW — server wins.
        const updatedGroup: SavedGroup = {
          id: sg.id,
          name: sg.name,
          color: sg.color as TabGroupColor,
          isCompact: sg.is_compact,
          createdAt: new Date(sg.created_at).toISOString(),
          seq: sg.seq,
          workspaceId: sg.workspace_id,
        };
        if (idx === -1) {
          groups.push(updatedGroup);
        } else {
          groups[idx] = updatedGroup;
        }
        // Replace tab snapshot: remove old tabs then add server tabs.
        groupTabs = groupTabs.filter(t => t.groupId !== sg.id);
        for (const st of sg.tabs ?? []) {
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

  // Purge null-workspace groups from IDB (fire-and-forget).
  for (const id of nullWorkspaceIds) {
    idbDelete("groups", id);
  }

  // Persist valid groups to IDB (fire-and-forget).
  const state = get();
  for (const sg of serverGroups) {
    if (nullWorkspaceIds.has(sg.id)) { continue; }
    const group = state.groups.find(g => g.id === sg.id);
    if (group) { idbPut("groups", group); }
    if (sg.deleted_at) {
      // Local tabs are preserved (see state logic above); only sync IDB if
      // server actually returned tabs for this deleted group.
      for (const t of sg.tabs) { idbPut("group-tabs", { id: t.id, groupId: t.group_id, title: t.title, url: t.url, favicon: t.favicon, position: t.position }); }
    } else {
      for (const t of state.groupTabs.filter(t => t.groupId === sg.id)) {
        idbPut("group-tabs", t);
      }
    }
  }
},
```

- [ ] **Step 7: Verify build**

```bash
cd /Users/lieutenant/Documents/github/TabSlate && bun run compile
```

Expected: no TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add store/groups-store.ts
git commit -m "feat(groups): add workspaceId to SavedGroup, store primitives, hydrate/merge null-workspace purge"
```

---

## Task 5: Frontend Store — deleteWorkspace Group Cleanup

**Files:**
- Modify: `store/workspace-store.ts`

`deleteWorkspace` currently starts at line 423. It must soft-delete all active groups belonging to the workspace before removing the workspace record, so those groups get tombstoned on the server with a valid `workspace_id` instead of having it nulled via `ON DELETE SET NULL`.

- [ ] **Step 1: Add `useGroupsStore` import at the top of `workspace-store.ts`**

After the existing import on line 7 (`import { useBookmarksStore } from "@/store/bookmarks-store";`), add:

```ts
import { useGroupsStore } from "@/store/groups-store";
```

- [ ] **Step 2: Soft-delete groups at the start of `deleteWorkspace`**

The current `deleteWorkspace` starts (line 423):

```ts
deleteWorkspace: (id) => {
  const { workspaces, collections, activeWorkspaceId } = get();
```

Replace with:

```ts
deleteWorkspace: (id) => {
  // Soft-delete all active groups in this workspace so they get tombstoned
  // on the server with a valid workspace_id (avoids ON DELETE SET NULL).
  const { groups, deleteGroup } = useGroupsStore.getState();
  for (const g of groups) {
    if (g.workspaceId === id && !g.deletedAt) {
      deleteGroup(g.id);
    }
  }

  const { workspaces, collections, activeWorkspaceId } = get();
```

The rest of `deleteWorkspace` is unchanged.

- [ ] **Step 3: Verify build**

```bash
cd /Users/lieutenant/Documents/github/TabSlate && bun run compile
```

Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add store/workspace-store.ts
git commit -m "feat(groups): soft-delete workspace groups before workspace deletion"
```

---

## Task 6: Frontend — createGroup Callsites

**Files:**
- Modify: `components/dashboard/groups-panel/create-group-bar.tsx`
- Modify: `components/dashboard/tabs-panel/group-card.tsx`
- Modify: `components/dashboard/tabs-dnd-provider.tsx`
- Modify: `components/dashboard/sidebar/index.tsx`
- Modify: `components/dashboard/trash-content.tsx`

Six callsites total. `useWorkspaceStore` is already imported in all files except `create-group-bar.tsx`.

- [ ] **Step 1: Update `create-group-bar.tsx`**

Add import after the existing `useGroupsStore` import:

```ts
import { useWorkspaceStore } from "@/store/workspace-store";
```

In `CreateGroupBar`, add a selector and update `handleCreate` and its `useCallback` deps:

```ts
export function CreateGroupBar() {
  const createGroup = useGroupsStore(s => s.createGroup);
  const activeWorkspaceId = useWorkspaceStore(s => s.activeWorkspaceId);
  const [name, setName] = React.useState("");
  const [color, setColor] = React.useState<TabGroupColor>("blue");
  const [open, setOpen] = React.useState(false);

  const handleCreate = React.useCallback(() => {
    if (!name.trim()) { return; }
    createGroup(name.trim(), color, true, activeWorkspaceId);
    setName("");
    setColor("blue");
    setOpen(false);
  }, [createGroup, name, color, activeWorkspaceId]);
```

- [ ] **Step 2: Update `group-card.tsx` — `handleSaveAsGroup` (around line 137)**

`useWorkspaceStore` is already imported. Change the `handleSaveAsGroup` callback to read `activeWorkspaceId` imperatively:

```ts
const handleSaveAsGroup = useCallback(() => {
  const { createGroup, addTabToGroup } = useGroupsStore.getState();
  const { activeWorkspaceId } = useWorkspaceStore.getState();
  const savedGroupId = createGroup(displayTitle || "Unnamed", group.color, group.title.length === 1, activeWorkspaceId);
  for (const tab of tabs) {
    addTabToGroup(savedGroupId, { title: tab.title || "", url: tab.url, favicon: tab.favIconUrl || "" });
  }
  setSaveResult({ saved: tabs.length, skipped: 0 });
  setTimeout(() => setSaveResult(null), 3000);
}, [displayTitle, group.color, group.title, tabs]);
```

- [ ] **Step 3: Update `tabs-dnd-provider.tsx` — tab-group drop to sidebar-groups (around line 200)**

`useWorkspaceStore` is already imported. Add `activeWorkspaceId` destructure:

```ts
if (dropId === "sidebar-groups") {
  const { createGroup, addTabToGroup } = useGroupsStore.getState();
  const { activeWorkspaceId } = useWorkspaceStore.getState();
  const savedGroupId = createGroup(
    dragData.groupName || "Unnamed",
    dragData.groupColor,
    true,
    activeWorkspaceId
  );
  dragData.tabs.forEach((tab) => {
    addTabToGroup(savedGroupId, {
      title: tab.title,
      url: tab.url,
      favicon: tab.favIconUrl || "",
    });
  });
```

- [ ] **Step 4: Update `sidebar/index.tsx` — GroupDialog onSubmit (around line 515)**

`activeWorkspaceId` is already selected at line 195. Update the `onSubmit` callback:

```ts
onSubmit={(name, color, selectedTabs, isCompact) => {
  const { createGroup, addTabToGroup } = useGroupsStore.getState();
  const groupId = createGroup(name, color, isCompact, activeWorkspaceId);
  selectedTabs.forEach((tab) => {
    addTabToGroup(groupId, {
      title: tab.title,
      url: tab.url,
      favicon: tab.favIconUrl || "",
    });
  });
  setNewGroupOpen(false);
}}
```

- [ ] **Step 5: Update `trash-content.tsx` — `TrashedGroupCard.handleRestoreTab` (around line 306)**

`useWorkspaceStore` is already imported in this file. Update `handleRestoreTab` inside `TrashedGroupCard`:

```ts
const handleRestoreTab = (tab: GroupTab) => {
  const activeGroups = useGroupsStore.getState().groups;
  const { activeWorkspaceId } = useWorkspaceStore.getState();
  const existing = activeGroups.find(g => g.name === group.name && !g.deletedAt);
  const targetId = existing ? existing.id : createGroup(group.name, group.color, group.isCompact, activeWorkspaceId);
  addTabToGroup(targetId, { title: tab.title, url: tab.url, favicon: tab.favicon });
  deleteTabFromTrash(tab.id);
};
```

- [ ] **Step 6: Update `trash-content.tsx` — bulk partial-group restore (around line 648)**

`activeWorkspaceId` is already selected at line 434. Update the `createGroup` call:

```ts
const targetId = existing ? existing.id : createGroup(group.name, group.color, group.isCompact, activeWorkspaceId);
```

- [ ] **Step 7: Verify build**

```bash
cd /Users/lieutenant/Documents/github/TabSlate && bun run compile
```

Expected: no TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add components/dashboard/groups-panel/create-group-bar.tsx \
        components/dashboard/tabs-panel/group-card.tsx \
        components/dashboard/tabs-dnd-provider.tsx \
        components/dashboard/sidebar/index.tsx \
        components/dashboard/trash-content.tsx
git commit -m "feat(groups): pass activeWorkspaceId to all createGroup callsites"
```

---

## Task 7: Frontend — UI Filtering

**Files:**
- Modify: `components/dashboard/groups-panel/index.tsx`
- Modify: `components/dashboard/sidebar/index.tsx`
- Modify: `components/dashboard/trash-content.tsx`

- [ ] **Step 1: Filter active groups by workspace in `groups-panel/index.tsx`**

Add `useWorkspaceStore` import after the existing `useGroupsStore` import:

```ts
import { useWorkspaceStore } from "@/store/workspace-store";
```

In `GroupsPanel`, add `activeWorkspaceId` selector and update `activeGroups` useMemo:

```ts
export function GroupsPanel() {
  const openTabs = useTabsStore(s => s.openTabs);
  const loadTabs = useTabsStore(s => s.loadTabs);
  const groups = useGroupsStore(s => s.groups);
  const groupTabs = useGroupsStore(s => s.groupTabs);
  const activeWorkspaceId = useWorkspaceStore(s => s.activeWorkspaceId);

  const activeGroups = React.useMemo(
    () => groups.filter(g => !g.deletedAt && g.workspaceId === activeWorkspaceId),
    [groups, activeWorkspaceId]
  );
```

- [ ] **Step 2: Filter groups by workspace in `sidebar/index.tsx`**

`activeWorkspaceId` is already selected at line 195. Update the `groups` useMemo (line 191):

```ts
const groups = React.useMemo(
  () => allGroups.filter(g => !g.deletedAt && g.workspaceId === activeWorkspaceId),
  [allGroups, activeWorkspaceId]
);
```

- [ ] **Step 3: Filter `trashedGroups` by workspace in `trash-content.tsx`**

`activeWorkspaceId` is already selected at line 434. Update `trashedGroups` useMemo (line 445):

```ts
const trashedGroups = React.useMemo(
  () => allGroups.filter(g => !!g.deletedAt && g.workspaceId === activeWorkspaceId),
  [allGroups, activeWorkspaceId]
);
```

- [ ] **Step 4: Verify build**

```bash
cd /Users/lieutenant/Documents/github/TabSlate && bun run compile
```

Expected: no TypeScript errors.

- [ ] **Step 5: Full build check**

```bash
cd /Users/lieutenant/Documents/github/TabSlate && bun run build
```

Expected: build succeeds with no errors.

- [ ] **Step 6: Commit**

```bash
git add components/dashboard/groups-panel/index.tsx \
        components/dashboard/sidebar/index.tsx \
        components/dashboard/trash-content.tsx
git commit -m "feat(groups): filter groups panel, sidebar, and trash view by active workspace"
```
