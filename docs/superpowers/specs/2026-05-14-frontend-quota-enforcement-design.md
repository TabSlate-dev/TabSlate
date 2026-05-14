# Frontend Quota Enforcement Design

**Date:** 2026-05-14  
**Status:** Approved

---

## Overview

Add client-side quota enforcement so users receive immediate feedback when they hit plan limits, instead of silently failing at sync time. The backend already exposes `GET /api/plan` (subscription + limits + usage). The frontend needs to fetch this data, check it before each create operation, and show a clear Alert when a limit is reached.

---

## Architecture

A new `usePlanStore` holds the quota data. Store create actions check quota via `planStore.checkQuota()` before writing to local state or the sync queue. When a limit is hit, `showQuotaAlert()` writes to `planStore.quotaAlert`, which a top-level `<QuotaAlert />` component subscribes to and renders. No calling component needs to handle errors — the alert fires automatically.

---

## Part 1: `usePlanStore` (`store/plan-store.ts`)

### State

```ts
interface PlanState {
  subscription: Subscription | null
  limits: Limits | null
  usage: PlanUsage | null
  fetchedAt: number | null        // unix ms; null = never fetched
  isFetching: boolean
  quotaAlert: QuotaAlert | null
}

interface PlanUsage {
  workspaces: number
  bookmarks: number
  collections: number
  tags: number
  saved_groups: number
}

interface QuotaAlert {
  resource: 'bookmark' | 'collection' | 'tag' | 'workspace' | 'saved_group'
  limit: number
}

type QuotaResource = QuotaAlert['resource']
```

### Actions

| Action | Behaviour |
|---|---|
| `fetchPlan(serverUrl, accessToken)` | `GET /api/plan`, updates all state, sets `fetchedAt = Date.now()` |
| `ensureFresh(serverUrl, accessToken)` | If `fetchedAt` is null or `Date.now() - fetchedAt > 5 * 60 * 1000`, calls `fetchPlan` in background (no await) |
| `checkQuota(resource)` | Returns `true` (allowed) if `limits` is null (not yet loaded), or if the relevant max is -1, or if `usage[resource] < limit`. Returns `false` if at or over limit |
| `incrementUsage(resource)` | `usage[resource] += 1` |
| `decrementUsage(resource)` | `usage[resource] = Math.max(0, usage[resource] - 1)` |
| `showQuotaAlert(resource)` | Sets `quotaAlert`; clears previous timer; auto-clears after 3 s via module-level timer variable |
| `clear()` | Resets all state to initial values (called on logout) |

### checkQuota logic

```ts
checkQuota(resource: QuotaResource): boolean {
  const { limits, usage } = get()
  if (!limits || !usage) return true   // not loaded yet → allow (fail open)
  const maxMap: Record<QuotaResource, number> = {
    bookmark:    limits.max_bookmarks,
    collection:  limits.max_collections,
    tag:         limits.max_tags,
    workspace:   limits.max_workspaces,
    saved_group: limits.max_saved_groups,
  }
  const max = maxMap[resource]
  if (max === -1) return true          // unlimited
  return usage[resource] < max
}
```

### showQuotaAlert timer pattern

```ts
let _quotaAlertTimer: ReturnType<typeof setTimeout> | null = null

showQuotaAlert(resource) {
  clearTimeout(_quotaAlertTimer ?? undefined)
  const limits = get().limits
  const limitKeyMap: Record<QuotaResource, keyof Limits> = {
    bookmark:    'max_bookmarks',
    collection:  'max_collections',
    tag:         'max_tags',
    workspace:   'max_workspaces',
    saved_group: 'max_saved_groups',
  }
  const limit = limits?.[limitKeyMap[resource]] ?? 0
  set({ quotaAlert: { resource, limit } })
  _quotaAlertTimer = setTimeout(() => set({ quotaAlert: null }), 3000)
}
```

### Auth lifecycle

- `fetchPlan` is called once in `App.tsx` after `StoreGate` confirms `authHydrated && accessToken && user.is_verified`.
- On logout, `usePlanStore.getState().clear()` is called within the existing `clearAllLocalData` flow.
- `limits/usage` null during initial load → `checkQuota` returns `true` → no false-positive blocks.

---

## Part 2: Store Action Changes

### Pattern (applied to all create actions)

```ts
// At the top of any create action:
const planStore = usePlanStore.getState()
planStore.ensureFresh(serverUrl, accessToken)   // background refresh if stale
if (!planStore.checkQuota('bookmark')) {
  planStore.showQuotaAlert('bookmark')
  return                                         // abort — nothing written to local state or sync queue
}

// ... normal create logic ...

planStore.incrementUsage('bookmark')             // after successful local write
```

### Actions to add quota check + incrementUsage

| Store | Action | Resource |
|---|---|---|
| `bookmarks-store.ts` | `addBookmark` | `'bookmark'` |
| `bookmarks-store.ts` | `addBookmarks` | `'bookmark'` (check once before batch; if over limit abort entire batch) |
| `workspace-store.ts` | `createWorkspace` | `'workspace'` |
| `workspace-store.ts` | `createCollection` | `'collection'` |
| `workspace-store.ts` | `createTag` | `'tag'` |
| `groups-store.ts` | `createGroup` | `'saved_group'` |

### Actions to add decrementUsage only (no quota check)

| Store | Action | Resource |
|---|---|---|
| `bookmarks-store.ts` | `deleteBookmark` (permanent) | `'bookmark'` |
| `workspace-store.ts` | `deleteCollection` / `permanentlyDeleteCollection` | `'collection'` |
| `workspace-store.ts` | `trashCollectionBookmarks` | `'bookmark'` (action already has the bookmark array being moved; call `decrementUsage('bookmark')` with `bookmarks.length`) |
| `workspace-store.ts` | `deleteWorkspace` | `'workspace'` |
| `workspace-store.ts` | `deleteTag` | `'tag'` |
| `groups-store.ts` | `deleteGroup` (soft delete to trash) | `'saved_group'` |

**Note:** `trashCollectionBookmarks` moves bookmarks to trash — these leave the active count, so `decrementUsage('bookmark')` by the number of bookmarks affected. `restoreFromTrash` / `restoreGroup` call `incrementUsage` to restore the count.

### Return types

Store actions keep `void` return type. Quota rejection is communicated entirely via `showQuotaAlert`, not via return values. Calling components (dialogs, DnD handlers) require zero changes.

---

## Part 3: QuotaAlert Component

### File: `components/ui/quota-alert.tsx`

Subscribes to `usePlanStore(s => s.quotaAlert)`. Renders nothing when null; renders a fixed Alert when set.

```tsx
export function QuotaAlert() {
  const alert = usePlanStore(s => s.quotaAlert)
  if (!alert) return null

  return (
    <Alert className="fixed top-4 left-1/2 -translate-x-1/2 z-100 w-auto shadow-lg animate-in fade-in slide-in-from-top-2 pointer-events-none whitespace-nowrap">
      <AlertCircle className="h-4 w-4" />
      <AlertDescription>{quotaAlertMessage(alert)}</AlertDescription>
    </Alert>
  )
}
```

### Alert messages (`quotaAlertMessage`)

```ts
function quotaAlertMessage({ resource, limit }: QuotaAlert): string {
  const map: Record<QuotaResource, string> = {
    bookmark:    `已达书签上限（${limit} 条），请升级套餐以继续添加`,
    collection:  `已达集合上限（${limit} 个），请升级套餐以继续创建`,
    tag:         `已达标签上限（${limit} 个），请升级套餐以继续创建`,
    workspace:   `已达工作区上限（${limit} 个），请升级套餐以继续创建`,
    saved_group: `已达已保存分组上限（${limit} 个），请升级套餐以继续创建`,
  }
  return map[resource]
}
```

### Mount location

`<QuotaAlert />` is rendered inside `App.tsx` within the `StoreGate`-guarded dashboard section, at the same level as any existing floating alerts.

---

## Part 4: API Integration

### New function in `lib/api.ts`

```ts
export interface PlanResponse {
  subscription: { plan: string; status: string; expires_at: number | null }
  limits: {
    max_workspaces: number
    max_bookmarks: number
    max_collections: number
    max_tags: number
    max_saved_groups: number
    trash_grace_days: number
  }
  usage: {
    workspaces: number
    bookmarks: number
    collections: number
    tags: number
    saved_groups: number
  }
}

// Added to api object:
getPlan: (serverUrl: string, accessToken: string) => Promise<PlanResponse>
```

---

## Scope

| In scope | Out of scope |
|---|---|
| `usePlanStore` with TTL-based lazy refresh | Disabling/greying out create buttons |
| Quota check in 6 create actions | Showing usage progress bars in UI |
| Decrement in delete/trash actions | Restore path increment (can follow up) |
| `<QuotaAlert />` fixed Alert component | Upgrade flow / checkout link in alert |
| `fetchPlan` triggered from `App.tsx` on auth | Syncing quota with pull response |

---

## Files Changed

| File | Change |
|---|---|
| `store/plan-store.ts` | **Create** — full plan store |
| `lib/api.ts` | Add `getPlan` + `PlanResponse` type |
| `store/bookmarks-store.ts` | Add quota check to `addBookmark`, `addBookmarks`; decrement on delete |
| `store/workspace-store.ts` | Add quota check to `createWorkspace`, `createCollection`, `createTag`; decrement on delete |
| `store/groups-store.ts` | Add quota check to `createGroup`; decrement on `deleteGroup` |
| `components/ui/quota-alert.tsx` | **Create** — fixed Alert component |
| `entrypoints/newtab/App.tsx` | Mount `<QuotaAlert />`, call `fetchPlan` post-auth, call `clear()` on logout |
