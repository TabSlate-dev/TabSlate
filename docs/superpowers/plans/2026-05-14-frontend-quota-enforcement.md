# Frontend Quota Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add client-side quota enforcement so users see an immediate Alert when they hit plan limits, instead of silently failing at sync time.

**Architecture:** A new `usePlanStore` fetches `GET /api/plan` on login and caches results for 5 minutes. Each create action in the three stores calls `planStore.checkQuota()` before writing; on failure it calls `planStore.showQuotaAlert()` and returns early. A `<QuotaAlert />` component at the app root subscribes to `planStore.quotaAlert` and renders a fixed Alert automatically — no calling component changes required.

**Tech Stack:** TypeScript, React, Zustand, existing `lib/api.ts` request pattern, shadcn `<Alert>` component.

---

## File Map

| File | Change |
|---|---|
| `lib/api.ts` | Add `PlanResponse` interface + `getPlan` function |
| `store/plan-store.ts` | **Create** — quota store with fetch, checkQuota, showQuotaAlert, increment/decrement |
| `components/ui/quota-alert.tsx` | **Create** — fixed Alert component driven by plan store |
| `entrypoints/newtab/App.tsx` | Trigger `fetchPlan` post-auth; add `<QuotaAlert />`; clear plan store on logout |
| `store/bookmarks-store.ts` | Quota check in `addBookmark`/`addBookmarks`; decrement in `trashCollectionBookmarks` |
| `store/workspace-store.ts` | Quota check in `createWorkspace`/`createCollection`/`createTag`; decrement in delete actions |
| `store/groups-store.ts` | Quota check in `createGroup`; decrement in `deleteGroup`; increment in `restoreGroup` |

---

## Task 1: Add `getPlan` to `lib/api.ts`

**Files:**
- Modify: `lib/api.ts`

- [ ] **Step 1: Add `PlanResponse` interface**

In `lib/api.ts`, after the existing `MeResponse` interface (around line 25), add:

```ts
export interface PlanLimits {
  max_workspaces: number;
  max_bookmarks: number;
  max_collections: number;
  max_tags: number;
  max_saved_groups: number;
  trash_grace_days: number;
}

export interface PlanUsage {
  workspaces: number;
  bookmarks: number;
  collections: number;
  tags: number;
  saved_groups: number;
}

export interface PlanResponse {
  subscription: { plan: string; status: string; expires_at: number | null };
  limits: PlanLimits;
  usage: PlanUsage;
}
```

- [ ] **Step 2: Add `getPlan` to the `api` object**

In `lib/api.ts`, inside the `export const api = { ... }` object, add the following method alongside `me`:

```ts
getPlan: (serverUrl: string, accessToken: string): Promise<PlanResponse> =>
  request<PlanResponse>(serverUrl, "/api/plan", {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  }),
```

- [ ] **Step 3: Verify compile**

```bash
cd /Users/lieutenant/Documents/github/TabSlate && bun run compile
```

Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add lib/api.ts
git commit -m "feat: add getPlan API method and PlanResponse types"
```

---

## Task 2: Create `store/plan-store.ts`

**Files:**
- Create: `store/plan-store.ts`

- [ ] **Step 1: Create the file**

Create `/Users/lieutenant/Documents/github/TabSlate/store/plan-store.ts` with the following content:

```ts
import { create } from "zustand";
import { api, type PlanLimits, type PlanUsage } from "@/lib/api";
import { useAuthStore } from "@/store/auth-store";

export type QuotaResource = "bookmark" | "collection" | "tag" | "workspace" | "saved_group";

interface QuotaAlert {
  resource: QuotaResource;
  limit: number;
}

interface PlanState {
  subscription: { plan: string; status: string; expires_at: number | null } | null;
  limits: PlanLimits | null;
  usage: PlanUsage | null;
  fetchedAt: number | null;
  isFetching: boolean;
  quotaAlert: QuotaAlert | null;

  fetchPlan: () => Promise<void>;
  ensureFresh: () => void;
  checkQuota: (resource: QuotaResource) => boolean;
  incrementUsage: (resource: QuotaResource, by?: number) => void;
  decrementUsage: (resource: QuotaResource, by?: number) => void;
  showQuotaAlert: (resource: QuotaResource) => void;
  clear: () => void;
}

const TTL_MS = 5 * 60 * 1000;

const LIMIT_KEY: Record<QuotaResource, keyof PlanLimits> = {
  bookmark:    "max_bookmarks",
  collection:  "max_collections",
  tag:         "max_tags",
  workspace:   "max_workspaces",
  saved_group: "max_saved_groups",
};

const USAGE_KEY: Record<QuotaResource, keyof PlanUsage> = {
  bookmark:    "bookmarks",
  collection:  "collections",
  tag:         "tags",
  workspace:   "workspaces",
  saved_group: "saved_groups",
};

let _alertTimer: ReturnType<typeof setTimeout> | null = null;

export const usePlanStore = create<PlanState>((set, get) => ({
  subscription: null,
  limits: null,
  usage: null,
  fetchedAt: null,
  isFetching: false,
  quotaAlert: null,

  fetchPlan: async () => {
    const { serverUrl, accessToken } = useAuthStore.getState();
    if (!serverUrl || !accessToken) { return; }
    if (get().isFetching) { return; }
    set({ isFetching: true });
    try {
      const data = await api.getPlan(serverUrl, accessToken);
      set({
        subscription: data.subscription,
        limits: data.limits,
        usage: data.usage,
        fetchedAt: Date.now(),
        isFetching: false,
      });
    } catch {
      set({ isFetching: false });
    }
  },

  ensureFresh: () => {
    const { fetchedAt, isFetching } = get();
    if (isFetching) { return; }
    if (fetchedAt !== null && Date.now() - fetchedAt < TTL_MS) { return; }
    void get().fetchPlan();
  },

  checkQuota: (resource) => {
    const { limits, usage } = get();
    if (!limits || !usage) { return true; }
    const max = limits[LIMIT_KEY[resource]];
    if (max === -1) { return true; }
    return usage[USAGE_KEY[resource]] < max;
  },

  incrementUsage: (resource, by = 1) => {
    set((s) => {
      if (!s.usage) { return {}; }
      const key = USAGE_KEY[resource];
      return { usage: { ...s.usage, [key]: s.usage[key] + by } };
    });
  },

  decrementUsage: (resource, by = 1) => {
    set((s) => {
      if (!s.usage) { return {}; }
      const key = USAGE_KEY[resource];
      return { usage: { ...s.usage, [key]: Math.max(0, s.usage[key] - by) } };
    });
  },

  showQuotaAlert: (resource) => {
    if (_alertTimer !== null) { clearTimeout(_alertTimer); }
    const limits = get().limits;
    const limit = limits ? limits[LIMIT_KEY[resource]] : 0;
    set({ quotaAlert: { resource, limit } });
    _alertTimer = setTimeout(() => {
      set({ quotaAlert: null });
      _alertTimer = null;
    }, 3000);
  },

  clear: () => {
    if (_alertTimer !== null) { clearTimeout(_alertTimer); _alertTimer = null; }
    set({
      subscription: null,
      limits: null,
      usage: null,
      fetchedAt: null,
      isFetching: false,
      quotaAlert: null,
    });
  },
}));
```

- [ ] **Step 2: Verify compile**

```bash
cd /Users/lieutenant/Documents/github/TabSlate && bun run compile
```

Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add store/plan-store.ts
git commit -m "feat: add usePlanStore with quota check, alert, and TTL refresh"
```

---

## Task 3: Create `components/ui/quota-alert.tsx`

**Files:**
- Create: `components/ui/quota-alert.tsx`

- [ ] **Step 1: Create the component**

Create `/Users/lieutenant/Documents/github/TabSlate/components/ui/quota-alert.tsx`:

```tsx
import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { usePlanStore, type QuotaResource } from "@/store/plan-store";

function quotaAlertMessage(resource: QuotaResource, limit: number): string {
  const messages: Record<QuotaResource, string> = {
    bookmark:    `已达书签上限（${limit} 条），请升级套餐以继续添加`,
    collection:  `已达集合上限（${limit} 个），请升级套餐以继续创建`,
    tag:         `已达标签上限（${limit} 个），请升级套餐以继续创建`,
    workspace:   `已达工作区上限（${limit} 个），请升级套餐以继续创建`,
    saved_group: `已达已保存分组上限（${limit} 个），请升级套餐以继续创建`,
  };
  return messages[resource];
}

export function QuotaAlert() {
  const alert = usePlanStore((s) => s.quotaAlert);
  if (!alert) { return null; }

  return (
    <Alert className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] w-auto shadow-lg animate-in fade-in slide-in-from-top-2 pointer-events-none whitespace-nowrap">
      <AlertCircle className="h-4 w-4" />
      <AlertDescription>{quotaAlertMessage(alert.resource, alert.limit)}</AlertDescription>
    </Alert>
  );
}
```

- [ ] **Step 2: Verify compile**

```bash
cd /Users/lieutenant/Documents/github/TabSlate && bun run compile
```

Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add components/ui/quota-alert.tsx
git commit -m "feat: add QuotaAlert component for plan limit notifications"
```

---

## Task 4: Wire up in `App.tsx`

**Files:**
- Modify: `entrypoints/newtab/App.tsx`

- [ ] **Step 1: Import plan store and QuotaAlert**

At the top of `entrypoints/newtab/App.tsx`, add two imports alongside the existing store imports:

```ts
import { usePlanStore } from "@/store/plan-store";
import { QuotaAlert } from "@/components/ui/quota-alert";
```

- [ ] **Step 2: Clear plan store on logout**

In `StoreGate`, find the existing logout `useEffect` (the one watching `accessToken` that calls `useWorkspaceStore.getState().reset()` etc). Add the plan store clear:

```ts
// Before (existing)
useEffect(() => {
  if (prevAccessTokenRef.current !== null && accessToken === null) {
    useWorkspaceStore.getState().reset();
    useBookmarksStore.getState().reset();
    useGroupsStore.getState().reset();
    useSettingsStore.getState().reset();
  }
  prevAccessTokenRef.current = accessToken;
}, [accessToken]);

// After
useEffect(() => {
  if (prevAccessTokenRef.current !== null && accessToken === null) {
    useWorkspaceStore.getState().reset();
    useBookmarksStore.getState().reset();
    useGroupsStore.getState().reset();
    useSettingsStore.getState().reset();
    usePlanStore.getState().clear();
  }
  prevAccessTokenRef.current = accessToken;
}, [accessToken]);
```

- [ ] **Step 3: Fetch plan post-auth**

In `AuthGate`, after the two early-return guards, add a `useEffect` that triggers `fetchPlan` when a verified user is present. Add this inside the `AuthGate` function body, before the return:

```tsx
function AuthGate({ children }: { children: React.ReactNode }) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const user = useAuthStore((s) => s.user);

  useEffect(() => {
    if (accessToken && user?.is_verified) {
      void usePlanStore.getState().fetchPlan();
    }
  }, [accessToken, user?.is_verified]);

  if (!accessToken) {
    return <AuthPage />;
  }
  if (user && !user.is_verified) {
    return <VerifyEmailScreen email={user.email} />;
  }
  return <>{children}</>;
}
```

- [ ] **Step 4: Mount `<QuotaAlert />`**

In the main `App` component's return, inside `<AuthGate>`, add `<QuotaAlert />` as a sibling to `<SyncProvider>`:

```tsx
<AuthGate>
  <QuotaAlert />
  <SyncProvider>
    {(syncStatus, onForceSync) => (
      // ... existing content unchanged
    )}
  </SyncProvider>
</AuthGate>
```

- [ ] **Step 5: Verify compile**

```bash
cd /Users/lieutenant/Documents/github/TabSlate && bun run compile
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add entrypoints/newtab/App.tsx
git commit -m "feat: wire plan store fetch and QuotaAlert into App lifecycle"
```

---

## Task 5: Quota enforcement in `bookmarks-store.ts`

**Files:**
- Modify: `store/bookmarks-store.ts`

- [ ] **Step 1: Import plan store**

Add to the imports at the top of `store/bookmarks-store.ts`:

```ts
import { usePlanStore } from "@/store/plan-store";
```

- [ ] **Step 2: Add quota check to `addBookmark`**

Find the `addBookmark` action (around line 177). Add the quota guard before the `set()` call:

```ts
addBookmark: (input) => {
  const planStore = usePlanStore.getState();
  planStore.ensureFresh();
  if (!planStore.checkQuota("bookmark")) {
    planStore.showQuotaAlert("bookmark");
    // Return a dummy bookmark so the return type is satisfied;
    // the caller discards it and no local state is written.
    return { id: "", createdAt: "", isFavorite: false, ...input } as Bookmark;
  }
  const bookmark: Bookmark = {
    id: generateId(),
    createdAt: new Date().toISOString(),
    isFavorite: false,
    ...input,
  };
  set((s) => ({ bookmarks: [bookmark, ...s.bookmarks] }));
  idbPut("bookmarks", bookmark);
  syncEngine?.enqueue({ bookmarks: [toServerBookmark(bookmark)] });
  planStore.incrementUsage("bookmark");
  return bookmark;
},
```

- [ ] **Step 3: Add quota check to `addBookmarks`**

Find `addBookmarks` (around line 190). Add the quota guard before `set()`:

```ts
addBookmarks: (newBookmarks) => {
  if (newBookmarks.length === 0) { return; }
  const planStore = usePlanStore.getState();
  planStore.ensureFresh();
  if (!planStore.checkQuota("bookmark")) {
    planStore.showQuotaAlert("bookmark");
    return;
  }
  set((s) => ({ bookmarks: [...newBookmarks, ...s.bookmarks] }));
  for (const b of newBookmarks) { idbPut("bookmarks", b); }
  syncEngine?.enqueue({ bookmarks: newBookmarks.map(b => toServerBookmark(b)) });
  planStore.incrementUsage("bookmark", newBookmarks.length);
},
```

- [ ] **Step 4: Add `decrementUsage` to `trashCollectionBookmarks`**

Find `trashCollectionBookmarks` (around line 411). After the existing `set(...)` call, add the decrement:

```ts
trashCollectionBookmarks: (collectionId) => {
  const active = get().bookmarks.filter(b => b.collectionId === collectionId);
  const archived = get().archivedBookmarks.filter(b => b.collectionId === collectionId);
  const all = [...active, ...archived];
  if (all.length === 0) { return; }
  for (const b of active) { idbDelete("bookmarks", b.id); idbPut("trashed-bookmarks", b); }
  for (const b of archived) { idbDelete("archived-bookmarks", b.id); idbPut("trashed-bookmarks", b); }
  syncEngine?.enqueue({ bookmarks: all.map(b => toServerBookmark(b, { isTrashed: 1 })) });
  set((s) => ({
    bookmarks: s.bookmarks.filter(b => b.collectionId !== collectionId),
    archivedBookmarks: s.archivedBookmarks.filter(b => b.collectionId !== collectionId),
    trashedBookmarks: [...s.trashedBookmarks, ...all],
  }));
  usePlanStore.getState().decrementUsage("bookmark", all.length);
},
```

- [ ] **Step 5: Verify compile**

```bash
cd /Users/lieutenant/Documents/github/TabSlate && bun run compile
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add store/bookmarks-store.ts
git commit -m "feat: add quota check to addBookmark/addBookmarks, decrement on trash"
```

---

## Task 6: Quota enforcement in `workspace-store.ts`

**Files:**
- Modify: `store/workspace-store.ts`

- [ ] **Step 1: Import plan store**

Add to the imports at the top of `store/workspace-store.ts`:

```ts
import { usePlanStore } from "@/store/plan-store";
```

- [ ] **Step 2: Add quota check to `createWorkspace`**

Find `createWorkspace` (around line 398). Add the quota guard at the top of the action, before the `const state = get()` line:

```ts
createWorkspace: (name, color) => {
  const planStore = usePlanStore.getState();
  planStore.ensureFresh();
  if (!planStore.checkQuota("workspace")) {
    planStore.showQuotaAlert("workspace");
    return undefined as unknown as Workspace;
  }
  const state = get();
  // ... rest of existing implementation unchanged ...
  // After syncEngine?.enqueue(...):
  planStore.incrementUsage("workspace");
  planStore.incrementUsage("collection"); // default collection also created
  return ws;
},
```

- [ ] **Step 3: Add quota check to `createCollection`**

Find `createCollection` (around line 479). Add quota guard at the top:

```ts
createCollection: (workspaceId, name, icon) => {
  const planStore = usePlanStore.getState();
  planStore.ensureFresh();
  if (!planStore.checkQuota("collection")) {
    planStore.showQuotaAlert("collection");
    return undefined as unknown as Collection;
  }
  const existingInWs = get().collections.filter(c => c.workspaceId === workspaceId);
  // ... rest of existing implementation unchanged ...
  // After syncEngine?.enqueue(...):
  planStore.incrementUsage("collection");
  return col;
},
```

- [ ] **Step 4: Add quota check to `createTag`**

Find `createTag` (around line 547). Add quota guard at the top:

```ts
createTag: (name, color) => {
  const planStore = usePlanStore.getState();
  planStore.ensureFresh();
  if (!planStore.checkQuota("tag")) {
    planStore.showQuotaAlert("tag");
    return undefined as unknown as Tag;
  }
  // ... rest of existing implementation unchanged ...
  // After idbPut / syncEngine?.enqueue:
  planStore.incrementUsage("tag");
  return tag; // (or however the existing action returns)
},
```

- [ ] **Step 5: Add `decrementUsage` to `deleteWorkspace`**

Find `deleteWorkspace` (around line 444). After the existing logic completes (after all groups and collections are processed), add:

```ts
// at the end of deleteWorkspace, before closing brace:
usePlanStore.getState().decrementUsage("workspace");
```

- [ ] **Step 6: Add `decrementUsage` to `deleteCollection`**

Find `deleteCollection` (around line 508). After `useBookmarksStore.getState().trashCollectionBookmarks(id)`:

```ts
// at the end of deleteCollection:
usePlanStore.getState().decrementUsage("collection");
// Note: trashCollectionBookmarks already decrements bookmark usage
```

- [ ] **Step 7: Add `decrementUsage` to `deleteTag`**

Find `deleteTag` (around line 566). At the end of the action:

```ts
usePlanStore.getState().decrementUsage("tag");
```

- [ ] **Step 8: Verify compile**

```bash
cd /Users/lieutenant/Documents/github/TabSlate && bun run compile
```

Expected: no TypeScript errors.

- [ ] **Step 9: Commit**

```bash
git add store/workspace-store.ts
git commit -m "feat: add quota checks to createWorkspace/Collection/Tag, decrement on delete"
```

---

## Task 7: Quota enforcement in `groups-store.ts`

**Files:**
- Modify: `store/groups-store.ts`

- [ ] **Step 1: Import plan store**

Add to the imports at the top of `store/groups-store.ts`:

```ts
import { usePlanStore } from "@/store/plan-store";
```

- [ ] **Step 2: Add quota check to `createGroup`**

Find `createGroup` (around line 104). Add quota guard at the top:

```ts
createGroup: (name, color, isCompact, workspaceId) => {
  const planStore = usePlanStore.getState();
  planStore.ensureFresh();
  if (!planStore.checkQuota("saved_group")) {
    planStore.showQuotaAlert("saved_group");
    return "";
  }
  const id = generateId();
  const group: SavedGroup = { id, name, color, isCompact, createdAt: new Date().toISOString(), seq: 0, workspaceId };
  syncEngine?.enqueue({ groups: [toServerGroup(group, [])] });
  set((state) => ({ groups: [...state.groups, group] }));
  idbPut("groups", group);
  planStore.incrementUsage("saved_group");
  return id;
},
```

- [ ] **Step 3: Add `decrementUsage` to `deleteGroup`**

Find `deleteGroup` (around line 152). At the end of the action:

```ts
// at the end of deleteGroup, after set(...):
usePlanStore.getState().decrementUsage("saved_group");
```

- [ ] **Step 4: Add `incrementUsage` to `restoreGroup`**

Find `restoreGroup` (around line 165). At the end of the action:

```ts
// at the end of restoreGroup, after set(...):
usePlanStore.getState().incrementUsage("saved_group");
```

- [ ] **Step 5: Verify compile**

```bash
cd /Users/lieutenant/Documents/github/TabSlate && bun run compile
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add store/groups-store.ts
git commit -m "feat: add quota check to createGroup, decrement/increment on delete/restore"
```

---

## Task 8: Final build verification

- [ ] **Step 1: Full TypeScript check**

```bash
cd /Users/lieutenant/Documents/github/TabSlate && bun run compile
```

Expected: no output (zero errors).

- [ ] **Step 2: Production build**

```bash
cd /Users/lieutenant/Documents/github/TabSlate && bun run build
```

Expected: build completes with no errors. A warning about bundle size is acceptable.

- [ ] **Step 3: Manual smoke test checklist**

Load the extension in Chrome (`chrome://extensions` → Load unpacked → `dist/`). Log in with a free-tier account.

- Temporarily lower the limit by checking what `GET /api/plan` returns in DevTools.
- Create bookmarks until the limit is hit → confirm fixed Alert appears at top center with correct message.
- Try drag-and-drop to add a bookmark when at limit → confirm same Alert fires.
- Create a collection at limit → Alert shows collection message.
- Create a tag at limit → Alert shows tag message.
- Create a saved group at limit → Alert shows saved_group message.
- Alert disappears after 3 seconds without any interaction.
- Delete a bookmark → verify subsequent create works (count decremented).
- Log out and log back in → plan data refreshes correctly.
