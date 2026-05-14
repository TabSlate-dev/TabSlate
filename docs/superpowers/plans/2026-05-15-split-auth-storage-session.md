# Split Auth Storage: accessToken → session Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `accessToken` out of `chrome.storage.local` into `chrome.storage.session` (with `TRUSTED_CONTEXTS` access level) so content scripts can no longer read it; wire up silent token refresh so users are not forced to re-login after browser restarts or mid-session token expiry.

**Architecture:** A new split adapter (`lib/auth-storage-adapter.ts`) replaces `chromeStorageAdapter` in the auth store. It reads `accessToken` from `chrome.storage.session["tabslate-auth-token"]` and all other fields from `chrome.storage.local["tabslate-auth"]`, merging them before returning to Zustand. On write it splits them. The background service worker restricts session storage to trusted contexts via `setAccessLevel`. The search overlay no longer reads auth from storage — the background reads it internally. A `silentRefresh()` action (deduplicated with a module-level singleton promise) is added to the auth store; it is called automatically on hydration (browser restart case) and on 401 in the sync-queue (mid-session expiry). On 401, the queue trusts IDB as source of truth — it fires refresh and returns; the newly-created SyncEngine calls `sweepUnsynced()` which re-queues all `seq=0` entities from IDB so no data is lost.

**Tech Stack:** TypeScript, Zustand persist middleware, Chrome Extension MV3 APIs (`chrome.storage.local`, `chrome.storage.session`), WXT

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `lib/auth-storage-adapter.ts` | **Create** | Split Zustand StateStorage adapter: session for token, local for rest |
| `store/auth-store.ts` | **Modify** | Swap adapter; add `silentRefresh` action + hydration trigger |
| `entrypoints/background.ts` | **Modify** | Call `setAccessLevel` at startup; update `SEARCH_BOOKMARKS` handler to read auth from storage |
| `lib/messages.ts` | **Modify** | Remove `accessToken` and `serverUrl` from `SEARCH_BOOKMARKS` message type |
| `lib/sync-queue.ts` | **Modify** | On 401, fire `silentRefresh` and return — new engine handles re-push via `sweepUnsynced` |
| `components/search/search-overlay.tsx` | **Modify** | Remove direct `chrome.storage.local` auth read; remove auth fields from message |

---

## Task 1: Create split auth storage adapter

**Files:**
- Create: `lib/auth-storage-adapter.ts`

Storage layout after this change:
- `chrome.storage.local["tabslate-auth"]` → Zustand JSON blob with `state.accessToken` always stripped out
- `chrome.storage.session["tabslate-auth-token"]` → `JSON.stringify({ accessToken: string })`, or absent when logged out

On `getItem`: merges local (minus accessToken) + session (token). Any stale `accessToken` that still exists in local storage from before this migration is silently ignored — it is never injected into Zustand state. The next `setItem` call will rewrite local storage without it.

On `setItem` with `accessToken: null` (logout): removes the session key entirely.

- [ ] **Step 1: Create the file**

```typescript
// lib/auth-storage-adapter.ts
import type { StateStorage } from "zustand/middleware";

const LOCAL_KEY = "tabslate-auth";
const SESSION_KEY = "tabslate-auth-token";

interface StoredAuthBlob {
  state?: { accessToken?: string | null; [key: string]: unknown };
  version?: number;
}

export const authStorageAdapter: StateStorage = {
  getItem: async (_name: string): Promise<string | null> => {
    const [localResult, sessionResult] = await Promise.all([
      chrome.storage.local.get(LOCAL_KEY),
      chrome.storage.session.get(SESSION_KEY),
    ]);

    const localRaw = localResult[LOCAL_KEY];
    if (typeof localRaw !== "string") { return null; }

    let blob: StoredAuthBlob;
    try {
      blob = JSON.parse(localRaw) as StoredAuthBlob;
    } catch {
      return null;
    }

    if (!blob?.state) { return localRaw; }

    // Strip any stale accessToken from local — it must only come from session
    delete blob.state.accessToken;

    const sessionRaw = sessionResult[SESSION_KEY];
    if (typeof sessionRaw === "string") {
      try {
        const { accessToken } = JSON.parse(sessionRaw) as { accessToken?: string };
        blob.state.accessToken = accessToken ?? null;
      } catch {
        blob.state.accessToken = null;
      }
    } else {
      blob.state.accessToken = null;
    }

    return JSON.stringify(blob);
  },

  setItem: async (_name: string, value: string): Promise<void> => {
    let blob: StoredAuthBlob;
    try {
      blob = JSON.parse(value) as StoredAuthBlob;
    } catch {
      return;
    }

    const accessToken = blob?.state?.accessToken ?? null;
    if (blob?.state) {
      delete blob.state.accessToken;
    }

    await Promise.all([
      new Promise<void>((resolve) =>
        chrome.storage.local.set({ [LOCAL_KEY]: JSON.stringify(blob) }, resolve),
      ),
      accessToken
        ? new Promise<void>((resolve) =>
            chrome.storage.session.set(
              { [SESSION_KEY]: JSON.stringify({ accessToken }) },
              resolve,
            ),
          )
        : new Promise<void>((resolve) =>
            chrome.storage.session.remove(SESSION_KEY, resolve),
          ),
    ]);
  },

  removeItem: async (_name: string): Promise<void> => {
    await Promise.all([
      new Promise<void>((resolve) => chrome.storage.local.remove(LOCAL_KEY, resolve)),
      new Promise<void>((resolve) => chrome.storage.session.remove(SESSION_KEY, resolve)),
    ]);
  },
};
```

- [ ] **Step 2: Verify type-check passes**

```bash
bun run compile
```

Expected: no errors related to the new file. `chrome.storage.session` and `chrome.storage.local` APIs are typed by `@types/chrome`.

---

## Task 2: Wire auth store to the new adapter

**Files:**
- Modify: `store/auth-store.ts:3,135`

- [ ] **Step 1: Swap the import and adapter**

In `store/auth-store.ts`, replace:

```typescript
import { chromeStorageAdapter } from "@/lib/chrome-storage-adapter";
```

with:

```typescript
import { authStorageAdapter } from "@/lib/auth-storage-adapter";
```

And replace the storage option (line 135):

```typescript
      storage: createJSONStorage(() => chromeStorageAdapter),
```

with:

```typescript
      storage: createJSONStorage(() => authStorageAdapter),
```

- [ ] **Step 2: Verify type-check passes**

```bash
bun run compile
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/auth-storage-adapter.ts store/auth-store.ts
git commit -m "feat: split auth storage — accessToken → chrome.storage.session"
```

---

## Task 3: Restrict session storage access in background + update SEARCH_BOOKMARKS handler

**Files:**
- Modify: `entrypoints/background.ts:7` (startup) and `:145-151` (SEARCH_BOOKMARKS handler)

The background service worker is a trusted context, so it can always read `chrome.storage.session`. Calling `setAccessLevel` ensures content scripts (untrusted contexts) cannot access session storage at all.

The `SEARCH_BOOKMARKS` handler currently receives `message.serverUrl` and `message.accessToken` from the overlay. After this task it reads both from storage internally so no auth credentials flow through content script messages.

- [ ] **Step 1: Add setAccessLevel call at background startup**

At the top of the `defineBackground` callback (after the opening `{` on line 7), add:

```typescript
  // Restrict session storage so content scripts cannot read it (Chrome 112+)
  chrome.storage.session.setAccessLevel({
    accessLevel: chrome.storage.AccessLevel.TRUSTED_CONTEXTS,
  });
```

- [ ] **Step 2: Update SEARCH_BOOKMARKS handler**

Replace the existing handler (lines 145–151):

```typescript
    if (message.type === "SEARCH_BOOKMARKS") {
      // Content scripts can't make cross-origin fetch calls; proxy through background.
      searchBookmarks(message.serverUrl, message.accessToken, message.query)
        .then(result => sendResponse({ ok: true, bookmarks: result.bookmarks }))
        .catch(() => sendResponse({ ok: false, bookmarks: [] }));
      return true; // keep channel open for async response
    }
```

with:

```typescript
    if (message.type === "SEARCH_BOOKMARKS") {
      (async () => {
        const [sessionResult, localResult] = await Promise.all([
          chrome.storage.session.get("tabslate-auth-token"),
          chrome.storage.local.get("tabslate-auth"),
        ]);

        let accessToken: string | null = null;
        const sessionRaw = sessionResult["tabslate-auth-token"];
        if (typeof sessionRaw === "string") {
          try { accessToken = (JSON.parse(sessionRaw) as { accessToken?: string }).accessToken ?? null; }
          catch { /* ignore */ }
        }

        let serverUrl: string | null = null;
        const localRaw = localResult["tabslate-auth"];
        if (typeof localRaw === "string") {
          try {
            serverUrl =
              (JSON.parse(localRaw) as { state?: { serverUrl?: string } })?.state?.serverUrl ?? null;
          }
          catch { /* ignore */ }
        }

        if (!accessToken || !serverUrl) {
          sendResponse({ ok: false, bookmarks: [] });
          return;
        }

        searchBookmarks(serverUrl, accessToken, message.query)
          .then((result) => sendResponse({ ok: true, bookmarks: result.bookmarks }))
          .catch(() => sendResponse({ ok: false, bookmarks: [] }));
      })();
      return true;
    }
```

- [ ] **Step 3: Verify type-check passes**

```bash
bun run compile
```

If `chrome.storage.AccessLevel` is not found: use the string literal `"TRUSTED_CONTEXTS"` and cast:
```typescript
(chrome.storage.session as chrome.storage.SessionStorageArea & {
  setAccessLevel: (opts: { accessLevel: string }) => void;
}).setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
```

---

## Task 4: Remove auth fields from SEARCH_BOOKMARKS message type

**Files:**
- Modify: `lib/messages.ts:12`

- [ ] **Step 1: Update the union type**

In `lib/messages.ts`, replace:

```typescript
  | { type: "SEARCH_BOOKMARKS"; query: string; accessToken: string; serverUrl: string };
```

with:

```typescript
  | { type: "SEARCH_BOOKMARKS"; query: string };
```

- [ ] **Step 2: Verify type-check passes**

```bash
bun run compile
```

Expected: TypeScript now reports errors in `search-overlay.tsx` where `accessToken` and `serverUrl` are passed in the message — this is expected and will be fixed in Task 5.

---

## Task 5: Remove direct auth reads from search overlay

**Files:**
- Modify: `components/search/search-overlay.tsx:36-105`

The overlay currently:
1. Reads `accessToken` + `serverUrl` directly from `chrome.storage.local` on mount
2. Guards the search call with `!accessToken`
3. Passes both as message fields

After this task, the overlay has no auth awareness at all — it just sends `{ type: "SEARCH_BOOKMARKS", query }` and the background handles auth internally.

- [ ] **Step 1: Remove auth state and storage effect**

Remove lines 36–56:

```typescript
  // Read auth from chrome.storage.local directly — Zustand's async persist
  // rehydration is unreliable in content script context (separate JS context).
  const [accessToken, setAccessToken] = React.useState<string | null>(null);
  const [serverUrl, setServerUrl] = React.useState<string>(
    (import.meta.env.VITE_API_URL as string | undefined) ?? "",
  );

  React.useEffect(() => {
    chrome.storage.local.get("tabslate-auth", (result) => {
      // chromeStorageAdapter stores via JSON.stringify, so value is a string
      const raw = result["tabslate-auth"];
      if (typeof raw !== "string") { return; }
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parsed = JSON.parse(raw) as any;
        const state = parsed?.state;
        if (state?.accessToken) {
          setAccessToken(state.accessToken as string);
          if (state.serverUrl) { setServerUrl(state.serverUrl as string); }
        }
      } catch { /* ignore malformed data */ }
    });
  }, []);
```

- [ ] **Step 2: Update the bookmark search effect**

Replace lines 88–105:

```typescript
  // Debounced bookmark search — proxied through background to avoid CORS
  React.useEffect(() => {
    if (query.length < 2 || !accessToken) {
      setBookmarkResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      chrome.runtime.sendMessage(
        { type: "SEARCH_BOOKMARKS", query, accessToken, serverUrl },
        (response: { ok: boolean; bookmarks: SearchBookmark[] }) => {
          if (!cancelled && response?.ok) {
            setBookmarkResults(response.bookmarks);
          }
        },
      );
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, accessToken, serverUrl]);
```

with:

```typescript
  // Debounced bookmark search — proxied through background to avoid CORS
  React.useEffect(() => {
    if (query.length < 2) {
      setBookmarkResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      chrome.runtime.sendMessage(
        { type: "SEARCH_BOOKMARKS", query },
        (response: { ok: boolean; bookmarks: SearchBookmark[] }) => {
          if (!cancelled && response?.ok) {
            setBookmarkResults(response.bookmarks);
          }
        },
      );
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query]);
```

- [ ] **Step 3: Verify type-check and build pass**

```bash
bun run compile && bun run build
```

Expected: no errors. The `accessToken`/`serverUrl` variables no longer exist, so any remaining references would surface here.

- [ ] **Step 4: Commit**

```bash
git add entrypoints/background.ts lib/messages.ts components/search/search-overlay.tsx
git commit -m "feat: background reads auth from session storage; overlay no longer handles credentials"
```

---

## Task 6: Add `silentRefresh` to auth store + wire hydration

**Files:**
- Modify: `store/auth-store.ts`

**Design decisions:**

| Scenario | Behavior |
|---|---|
| Refresh succeeds | Update `accessToken` + `refreshToken` in store; reset backoff delay |
| Refresh → 401/403 (definitive invalid) | Clear `accessToken` + `refreshToken` only — do NOT call `clearDB()`. IDB + localSeq intact so user's data survives and can re-sync after re-login |
| Refresh → network/5xx error | Schedule background retry with exponential backoff (2 s → 4 s → … 60 s cap); return false so callers can continue with stale/null token |
| Concurrent calls | Module-level `_refreshPromise` singleton — only one network request regardless of how many callers hit 401 simultaneously |
| Explicit `logout()` | Cancel any pending retry timer so it doesn't fire after user has logged out |

`onRehydrateStorage` calls `setHydrated()` **immediately** (no loading delay), then fires `silentRefresh()` in the background. AuthGate will show the dashboard as long as `refreshToken` exists — the user sees their local IDB data right away, and sync starts transparently once the new token arrives.

- [ ] **Step 1: Add `silentRefresh` to the `AuthState` interface**

In `store/auth-store.ts`, add to the `AuthState` interface after the `logout` line:

```typescript
  silentRefresh: () => Promise<boolean>;
```

- [ ] **Step 2: Verify `ApiError` is exported from `lib/api.ts` and update import**

```bash
grep -n "export class ApiError\|export { ApiError" /Users/lieutenant/Documents/github/TabSlate/lib/api.ts
```

If not found, add `export` to the `ApiError` class declaration in `api.ts`.

Then update the existing import at the top of `store/auth-store.ts` (line 4):

```typescript
// Before:
import { api } from "@/lib/api";
// After:
import { api, ApiError } from "@/lib/api";
```

Then add module-level variables above the store:

```typescript
let _refreshPromise: Promise<boolean> | null = null;
let _refreshRetryTimer: ReturnType<typeof setTimeout> | null = null;
let _refreshRetryDelay = 2000;
const MAX_REFRESH_RETRY_DELAY = 60_000;

function scheduleRefreshRetry() {
  if (_refreshRetryTimer) { return; }
  _refreshRetryTimer = setTimeout(() => {
    _refreshRetryTimer = null;
    _refreshRetryDelay = Math.min(_refreshRetryDelay * 2, MAX_REFRESH_RETRY_DELAY);
    void useAuthStore.getState().silentRefresh();
  }, _refreshRetryDelay);
}
```

- [ ] **Step 3: Add `silentRefresh` action inside the store factory**

After the closing `},` of the `logout` action, add:

```typescript
      silentRefresh: async () => {
        if (_refreshPromise) { return _refreshPromise; }
        const { serverUrl, refreshToken } = get();
        if (!refreshToken) { return false; }
        _refreshPromise = (async () => {
          try {
            const resp = await api.refresh(serverUrl, refreshToken);
            // Also update user — /auth/refresh returns fresh user data and refreshToken rotates.
            set({ accessToken: resp.access_token, refreshToken: resp.refresh_token, user: resp.user });
            _refreshRetryDelay = 2000;
            // Cancel any pending retry timer — refresh succeeded, no need to retry.
            if (_refreshRetryTimer) { clearTimeout(_refreshRetryTimer); _refreshRetryTimer = null; }
            return true;
          } catch (err) {
            if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
              // Definitively invalid — clear credentials but preserve IDB so the
              // user's data survives and can re-sync after logging back in.
              set({ accessToken: null, refreshToken: null });
              return false;
            }
            // Network / server error — retry in the background with backoff.
            scheduleRefreshRetry();
            return false;
          } finally {
            _refreshPromise = null;
          }
        })();
        return _refreshPromise;
      },
```

- [ ] **Step 4: Clear the retry timer in `logout`**

In the `logout` action, add before `await clearDB()`:

```typescript
        if (_refreshRetryTimer) { clearTimeout(_refreshRetryTimer); _refreshRetryTimer = null; }
```

- [ ] **Step 5: Update `onRehydrateStorage` — hydrate immediately, refresh in background**

Replace the existing `onRehydrateStorage` option (lines 136–145):

```typescript
      onRehydrateStorage: () => (state) => {
        if (state) {
          // If no serverUrl was persisted, fall back to the build-time env var.
          if (!state.serverUrl) {
            state.serverUrl =
              (import.meta.env.VITE_API_URL as string | undefined) ?? "";
          }
          state.setHydrated();
        }
      },
```

with:

```typescript
      onRehydrateStorage: () => (state) => {
        if (!state) { return; }
        if (!state.serverUrl) {
          state.serverUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? "";
        }
        // Mark hydrated immediately — AuthGate uses refreshToken to show the
        // dashboard optimistically while the background refresh completes.
        state.setHydrated();
        if (state.refreshToken && !state.accessToken) {
          void state.silentRefresh();
        }
      },
```

- [ ] **Step 6: Verify type-check passes**

```bash
bun run compile
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add store/auth-store.ts
git commit -m "feat: add silentRefresh with retry backoff; preserve IDB on token expiry"
```

---

## Task 7: Update AuthGate to show dashboard while refresh token exists

**Files:**
- Modify: `entrypoints/newtab/App.tsx:135-152`

**Design:** The guard changes from "must have `accessToken`" to "must have at least one token". With `refreshToken` persisted in local storage, after a browser restart the user sees their IDB-backed dashboard immediately while `silentRefresh()` runs in the background. SyncProvider already handles the `!accessToken` case by returning early (no sync until token arrives).

The `fetchPlan` effect already uses `accessToken && user?.is_verified` so it only fires once the token is ready.

The unverified-user guard (`user && !user.is_verified`) is kept but scoped to cases where a token exists — it would be unusual to have a `refreshToken` but an unverified user (they'd need to re-login first anyway).

- [ ] **Step 1: Add `refreshToken` selector and update guards**

Replace lines 135–152:

```typescript
/** Shows the auth page when no access token is present.
 *  If a token exists but the email is unverified, shows the OTP verification
 *  screen instead of the dashboard — prevents entering without verifying. */
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

with:

```typescript
/** Guards the dashboard:
 *  - No tokens at all → login page
 *  - refreshToken exists but accessToken pending → show dashboard optimistically
 *    (SyncProvider skips sync until accessToken arrives; data served from IDB)
 *  - Token exists but email unverified → OTP screen */
function AuthGate({ children }: { children: React.ReactNode }) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const user = useAuthStore((s) => s.user);

  useEffect(() => {
    if (accessToken && user?.is_verified) {
      void usePlanStore.getState().fetchPlan();
    }
  }, [accessToken, user?.is_verified]);

  if (!accessToken && !refreshToken) {
    return <AuthPage />;
  }
  if (accessToken && user && !user.is_verified) {
    return <VerifyEmailScreen email={user.email} />;
  }
  return <>{children}</>;
}
```

- [ ] **Step 2: Verify type-check and build pass**

```bash
bun run compile && bun run build
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add entrypoints/newtab/App.tsx
git commit -m "feat: show dashboard optimistically when refreshToken present, no login flash"
```

---

## Task 8: Handle 401 in sync-queue

**Files:**
- Modify: `lib/sync-queue.ts:1-3,98-117`

**Design:** When a push fails with 401, the snapshot has already been cleared from the in-memory queue. Rather than re-enqueueing and doing backoff retries (which would all 401 again), fire `silentRefresh()` and return. The auth store update triggers Zustand subscribers → SyncProvider recreates the engine → the new engine's initial pull calls `sweepUnsynced()`, which re-queues all `seq=0` entities from IDB. No data is lost because IDB is always the source of truth; the in-memory queue is just a push buffer.

For non-401 errors the existing re-enqueue + exponential backoff behavior is preserved exactly.

- [ ] **Step 1: Add imports**

In `lib/sync-queue.ts`, update the import block at the top:

```typescript
import { api, ApiError } from "@/lib/api";
import type { SyncPushPayload, SyncPushResponse } from "@/lib/api";
import { useAuthStore } from "@/store/auth-store";
```

(`ApiError` export and import were already verified and added in Task 6 Step 2.)

- [ ] **Step 2: Restructure the `doPush` catch block**

Replace lines 102–117 (the entire `catch` block) in `lib/sync-queue.ts`:

```typescript
    } catch (err) {
      // Re-enqueue snapshot so changes are not lost on failure.
      snapshot.entities.workspaces.forEach(e => this.queue.workspaces.set((e as { id: string }).id, e));
      snapshot.entities.collections.forEach(e => this.queue.collections.set((e as { id: string }).id, e));
      snapshot.entities.bookmarks.forEach(e => this.queue.bookmarks.set((e as { id: string }).id, e));
      snapshot.entities.tags.forEach(e => this.queue.tags.set((e as { id: string }).id, e));
      snapshot.entities.groups.forEach(e => this.queue.groups.set((e as { id: string }).id, e));

      this.onError(err instanceof Error ? err : new Error(String(err)));
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.doPush();
      }, this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, this.maxRetryDelay);
    }
```

with:

```typescript
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // Token expired. IDB is source of truth (entities remain seq=0 there).
        // Fire refresh; the auth store update recreates the SyncEngine via
        // SyncProvider, whose first pull calls sweepUnsynced() to re-queue
        // all seq=0 entities — no data lost, no duplicate push attempt.
        void useAuthStore.getState().silentRefresh();
        return;
      }

      // Network / server error — re-enqueue snapshot and retry with backoff.
      snapshot.entities.workspaces.forEach(e => this.queue.workspaces.set((e as { id: string }).id, e));
      snapshot.entities.collections.forEach(e => this.queue.collections.set((e as { id: string }).id, e));
      snapshot.entities.bookmarks.forEach(e => this.queue.bookmarks.set((e as { id: string }).id, e));
      snapshot.entities.tags.forEach(e => this.queue.tags.set((e as { id: string }).id, e));
      snapshot.entities.groups.forEach(e => this.queue.groups.set((e as { id: string }).id, e));

      this.onError(err instanceof Error ? err : new Error(String(err)));
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.doPush();
      }, this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, this.maxRetryDelay);
    }
```

- [ ] **Step 3: Verify type-check and build pass**

```bash
bun run compile && bun run build
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/sync-queue.ts lib/api.ts
git commit -m "feat: handle 401 in sync-queue via silentRefresh"
```

---

## Manual Smoke Test Checklist

After all commits, load the unpacked extension and verify:

- [ ] **Login flow**: Log in → tokens persisted. Refresh the new tab → still logged in (accessToken survived tab close, session still active).
- [ ] **Session storage**: Open DevTools → Application → Session Storage → extension origin → `tabslate-auth-token` exists and contains `accessToken`.
- [ ] **Local storage**: Open DevTools → Application → Local Storage → extension origin → `tabslate-auth` exists and does NOT contain `accessToken` inside the `state` object, but DOES contain `refreshToken`.
- [ ] **Browser restart — no login flash**: Close and reopen Chrome → dashboard renders immediately with IDB data → no login screen shown → after a moment, sync becomes active (silent refresh completed).
- [ ] **Search overlay** (`Ctrl+Shift+K` on any page): Type 3+ characters → bookmark results appear → no console errors about `accessToken`.
- [ ] **Logout**: Click logout → `tabslate-auth-token` session key removed → IDB cleared → redirected to login.
- [ ] **Expired refresh token (simulate by clearing `refreshToken` from local storage while extension is open)**: Extension shows login page, IDB is NOT cleared → user can log in and data re-syncs.
- [ ] **Dedup check**: Open 5 new tabs in quick succession after browser restart → Network tab shows only ONE call to `/auth/refresh`, not 5.
