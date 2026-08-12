# Offline Authentication Dialog and Collection Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open TabSlate directly into a fully usable offline dashboard, move the complete authentication and OTP flow into one sidebar-triggered dialog, synchronize preserved guest data after verification, and make active collection ordering canonical everywhere.

**Architecture:** Pure helpers in `lib/auth-session.ts` define session, guest-bootstrap, sync-gating, and auth-dialog presentation decisions. `StoreGate` always mounts the dashboard and seeds a guest workspace, `SyncProvider` starts only for verified sessions, and a sidebar-owned `AuthDialog` composes the existing credential and OTP forms. A pure collection comparator in `lib/collection-utils.ts` replaces duplicated ordering logic across the dashboard, popup, and store.

**Tech Stack:** TypeScript 5.9 strict mode, React 19, Zustand 5, React Router 7, WXT 0.20, Radix Dialog, shadcn/ui, Chrome i18n, IndexedDB, Bun test runner.

## Global Constraints

- Use Bun for dependency management and all verification commands.
- Do not change backend APIs, request payloads, token storage, CAPTCHA rules, OTP cooldowns, password-reset behavior, or server rate limiting.
- Preserve guest entities with `seq === 0`; authentication must merge and sync them rather than reset them.
- Preserve explicit logout's privacy behavior: clear account data, then create a fresh guest workspace.
- Do not start SyncEngine unless `serverUrl` and `accessToken` exist and `user.is_verified === true`.
- Keep SyncProvider cleanup ordered as best-effort `engine.forceSync()`, `engine.destroy()`, then `releaseSyncEngine(engine)`; never call `destroySyncEngine()` in the cleanup.
- Use fine-grained Zustand selectors; derive filtered and sorted arrays in `useMemo`, never in selectors.
- Use interfaces for object shapes, no `any`, no unnecessary assertions, and curly braces for every `if`.
- Active collections sort with Default first, then descending `position`.
- Keep dialogs on the standard shadcn structure and retain accessibility semantics.
- Do not create Markdown files except Superpowers specification and plan documents.

---

## File Map

### New files

- `lib/auth-session.ts` — pure session classification, guest initialization gate, sync eligibility, and auth-dialog presentation rules.
- `lib/collection-utils.ts` — canonical active collection comparator.
- `components/auth/auth-dialog.tsx` — controlled dialog that orchestrates credentials and OTP verification.
- `test/auth-session.test.js` — unit tests for session and dialog decision functions.
- `test/auth-store-session.test.js` — regression test for unauthorized refresh cleanup.
- `test/collection-utils.test.js` — unit tests for canonical collection ordering.
- `test/auth-i18n.test.js` — verifies required guest authentication copy in both locales.

### Modified files

- `entrypoints/newtab/App.tsx` — remove the full-screen auth gate, initialize guests, and gate sync by verified session status.
- `store/auth-store.ts` — clear IndexedDB before an invalid refresh token transitions to guest mode.
- `components/ui/dialog.tsx` — allow callers to hide the standard close button for mandatory OTP verification.
- `components/login-form.tsx` — accept an initial login/register mode while retaining internal switching.
- `components/auth/verify-email-screen.tsx` — render as dialog content and delegate “use another account” to the dialog.
- `components/dashboard/sidebar/index.tsx` — own AuthDialog state, wire both guest entry points, hide guest quota UI, and use canonical collection ordering.
- `components/dashboard/sidebar/user-profile.tsx` — render a clickable guest profile without conditional-hook violations.
- `components/dashboard/sidebar/sync-status.tsx` — render guest status and “Register now”.
- `components/dashboard/content.tsx` — use canonical ordering in grouped All Bookmarks.
- `components/dashboard/add-bookmark-dialog.tsx` — use the shared comparator.
- `components/dashboard/groups-panel/droppable-group-card.tsx` — use the shared comparator.
- `components/dashboard/group-detail/index.tsx` — use the shared comparator.
- `components/dashboard/tab-row.tsx` — use the shared comparator.
- `components/dashboard/import-dialog.tsx` — use the shared comparator.
- `entrypoints/popup/App.tsx` — filter active collections and use the shared comparator.
- `store/workspace-store.ts` — use the shared comparator in `getWorkspaceCollections`.
- `public/_locales/en/messages.json` — English guest/profile/sync strings.
- `public/_locales/zh_CN/messages.json` — Chinese guest/profile/sync strings.
- `CLAUDE.md` — replace obsolete AuthGate documentation with the offline/AuthDialog lifecycle.

### Deleted file

- `components/auth/auth-page.tsx` — obsolete standalone authentication page.

---

### Task 1: Define Testable Authentication Session Policy

**Files:**
- Create: `lib/auth-session.ts`
- Create: `test/auth-session.test.js`

**Interfaces:**
- Produces: `AuthSessionStatus = "guest" | "unverified" | "offline" | "verified"`.
- Produces: `resolveAuthSessionStatus(snapshot: AuthSessionSnapshot): AuthSessionStatus`.
- Produces: `shouldInitializeGuestWorkspace(input: GuestWorkspaceInitializationInput): boolean`.
- Produces: `shouldResetLocalData(previousStatus: AuthSessionStatus | null, currentStatus: AuthSessionStatus): boolean`.
- Produces: `canStartSync(status: AuthSessionStatus, serverUrl: string): boolean`.
- Later tasks consume these helpers from `entrypoints/newtab/App.tsx`.

- [ ] **Step 1: Write failing session-policy tests**

Create `test/auth-session.test.js` with explicit coverage for all four session states, guest initialization, and verified-only synchronization:

```js
import { describe, expect, test } from "bun:test";
import {
  canStartSync,
  resolveAuthSessionStatus,
  shouldInitializeGuestWorkspace,
  shouldResetLocalData,
} from "../lib/auth-session";

describe("authentication session policy", () => {
  test("classifies guest, unverified, offline, and verified sessions", () => {
    expect(resolveAuthSessionStatus({
      accessToken: null,
      refreshToken: null,
      isVerified: null,
    })).toBe("guest");

    expect(resolveAuthSessionStatus({
      accessToken: "access",
      refreshToken: "refresh",
      isVerified: false,
    })).toBe("unverified");

    expect(resolveAuthSessionStatus({
      accessToken: null,
      refreshToken: "refresh",
      isVerified: true,
    })).toBe("offline");

    expect(resolveAuthSessionStatus({
      accessToken: "access",
      refreshToken: "refresh",
      isVerified: true,
    })).toBe("verified");
  });

  test("initializes a workspace only for a hydrated empty guest", () => {
    expect(shouldInitializeGuestWorkspace({
      sessionStatus: "guest",
      storesHydrated: true,
      workspaceCount: 0,
    })).toBe(true);

    expect(shouldInitializeGuestWorkspace({
      sessionStatus: "guest",
      storesHydrated: false,
      workspaceCount: 0,
    })).toBe(false);

    expect(shouldInitializeGuestWorkspace({
      sessionStatus: "guest",
      storesHydrated: true,
      workspaceCount: 1,
    })).toBe(false);

    expect(shouldInitializeGuestWorkspace({
      sessionStatus: "offline",
      storesHydrated: true,
      workspaceCount: 0,
    })).toBe(false);
  });

  test("starts synchronization only for a verified session with a server URL", () => {
    expect(canStartSync("verified", "https://api.tabslate.com")).toBe(true);
    expect(canStartSync("verified", "")).toBe(false);
    expect(canStartSync("guest", "https://api.tabslate.com")).toBe(false);
    expect(canStartSync("unverified", "https://api.tabslate.com")).toBe(false);
    expect(canStartSync("offline", "https://api.tabslate.com")).toBe(false);
  });

  test("resets local account data only when a session becomes guest", () => {
    expect(shouldResetLocalData(null, "guest")).toBe(false);
    expect(shouldResetLocalData("guest", "verified")).toBe(false);
    expect(shouldResetLocalData("offline", "verified")).toBe(false);
    expect(shouldResetLocalData("verified", "guest")).toBe(true);
    expect(shouldResetLocalData("unverified", "guest")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and verify the missing-module failure**

Run:

```bash
bun test test/auth-session.test.js
```

Expected: FAIL because `lib/auth-session.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure policy module**

Create `lib/auth-session.ts`:

```ts
export type AuthSessionStatus =
  | "guest"
  | "unverified"
  | "offline"
  | "verified";

interface AuthSessionSnapshot {
  accessToken: string | null;
  refreshToken: string | null;
  isVerified: boolean | null;
}

interface GuestWorkspaceInitializationInput {
  sessionStatus: AuthSessionStatus;
  storesHydrated: boolean;
  workspaceCount: number;
}

export function resolveAuthSessionStatus({
  accessToken,
  refreshToken,
  isVerified,
}: AuthSessionSnapshot): AuthSessionStatus {
  if (!accessToken && !refreshToken) {
    return "guest";
  }
  if (isVerified !== true) {
    return "unverified";
  }
  if (!accessToken) {
    return "offline";
  }
  return "verified";
}

export function shouldInitializeGuestWorkspace({
  sessionStatus,
  storesHydrated,
  workspaceCount,
}: GuestWorkspaceInitializationInput): boolean {
  return storesHydrated && sessionStatus === "guest" && workspaceCount === 0;
}

export function canStartSync(
  status: AuthSessionStatus,
  serverUrl: string,
): boolean {
  return status === "verified" && serverUrl.length > 0;
}

export function shouldResetLocalData(
  previousStatus: AuthSessionStatus | null,
  currentStatus: AuthSessionStatus,
): boolean {
  return previousStatus !== null &&
    previousStatus !== "guest" &&
    currentStatus === "guest";
}
```

- [ ] **Step 4: Run the focused test**

Run:

```bash
bun test test/auth-session.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit the policy module**

```bash
git add lib/auth-session.ts test/auth-session.test.js
git commit -m "test: define offline auth session policy"
```

---

### Task 2: Mount the Dashboard for Guests and Protect Session Transitions

**Files:**
- Create: `test/auth-store-session.test.js`
- Modify: `entrypoints/newtab/App.tsx:126-200,203-334,360-392`
- Modify: `store/auth-store.ts:115-149`
- Delete: `components/auth/auth-page.tsx`

**Interfaces:**
- Consumes: `resolveAuthSessionStatus`, `shouldInitializeGuestWorkspace`, `shouldResetLocalData`, and `canStartSync` from Task 1.
- Produces: an always-mounted dashboard after hydration.
- Produces: exactly one guest workspace/default collection on an empty guest database.
- Produces: verified-only SyncEngine startup while retaining the existing offline refresh retry.

- [ ] **Step 1: Write the failing invalid-refresh cleanup regression test**

Create `test/auth-store-session.test.js`. Mock the persistence adapter so importing the store does not touch Chrome storage, then assert that a 401 refresh clears IndexedDB before auth state becomes guest:

```js
import { beforeEach, describe, expect, mock, test } from "bun:test";

const clearDBCalls = [];

class MockApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const refresh = mock(async () => {
  throw new MockApiError("invalid refresh token", 401);
});

mock.module("@/lib/api", () => ({
  ApiError: MockApiError,
  api: { refresh },
}));

mock.module("@/lib/idb", () => ({
  clearDB: async () => {
    clearDBCalls.push("cleared");
  },
}));

mock.module("@/lib/sync-recovery", () => ({
  clearSyncRecoverySnapshot: () => {},
}));

mock.module("@/store/i18n-store", () => ({
  useI18nStore: { getState: () => ({ language: "en" }) },
  resolveAcceptLanguage: () => "en",
}));

mock.module("@/lib/auth-storage-adapter", () => ({
  authStorageAdapter: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  },
}));

const { useAuthStore } = await import("../store/auth-store");

describe("invalid authenticated session cleanup", () => {
  beforeEach(() => {
    clearDBCalls.length = 0;
    refresh.mockClear();
    useAuthStore.setState({
      user: {
        id: "user-1",
        name: "User",
        email: "user@example.com",
        is_verified: true,
      },
      accessToken: null,
      refreshToken: "invalid-refresh",
      serverUrl: "https://api.tabslate.com",
      otpSentAt: null,
    });
  });

  test("clears account data before transitioning to guest", async () => {
    const refreshed = await useAuthStore.getState().silentRefresh();

    expect(refreshed).toBe(false);
    expect(clearDBCalls).toEqual(["cleared"]);
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().refreshToken).toBeNull();
  });
});
```

- [ ] **Step 2: Run the cleanup test and verify it fails**

Run:

```bash
bun test test/auth-store-session.test.js
```

Expected: FAIL because the 401 path clears auth state without calling `clearDB()`.

- [ ] **Step 3: Clear IndexedDB before publishing the guest auth state**

In the `ApiError` 401/403 branch of `silentRefresh()` in `store/auth-store.ts`, preserve the existing retry cancellation and recovery cleanup, then await the already-imported `clearDB()` before `set(...)`:

```ts
if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
  clearRefreshRetry();
  clearSyncRecoverySnapshot();
  await clearDB();
  set({
    user: null,
    accessToken: null,
    refreshToken: null,
    otpSentAt: null,
  });
  return false;
}
```

- [ ] **Step 4: Replace AuthGate with guest bootstrap in StoreGate**

In `entrypoints/newtab/App.tsx`:

1. Remove imports of `AuthPage` and `VerifyEmailScreen`.
2. Delete the `AuthGate` component.
3. Subscribe to `user`, workspace count, and `createWorkspace` with separate selectors.
4. Compute `hydrated` before the new effect and use Task 1's policy helpers.
5. Clear stale plan state for guests and seed only an empty, fully hydrated guest database.
6. Replace `prevHadSessionRef` with `prevSessionStatusRef` and use `shouldResetLocalData` so guest-to-authentication transitions never clear guest entities.

The new StoreGate logic must include:

```ts
const user = useAuthStore((s) => s.user);
const workspaceCount = useWorkspaceStore((s) => s.workspaces.length);
const createWorkspace = useWorkspaceStore((s) => s.createWorkspace);

const hydrated =
  bookmarksHydrated &&
  workspaceHydrated &&
  authHydrated &&
  groupsHydrated &&
  settingsHydrated;
const sessionStatus = resolveAuthSessionStatus({
  accessToken,
  refreshToken,
  isVerified: user?.is_verified ?? null,
});

useEffect(() => {
  if (shouldResetLocalData(prevSessionStatusRef.current, sessionStatus)) {
    useWorkspaceStore.getState().reset();
    useBookmarksStore.getState().reset();
    useGroupsStore.getState().reset();
    useSettingsStore.getState().reset();
    usePlanStore.getState().clear();
  }
  prevSessionStatusRef.current = sessionStatus;
}, [sessionStatus]);

useEffect(() => {
  if (!hydrated || sessionStatus !== "guest") {
    return;
  }

  usePlanStore.getState().clear();
  if (shouldInitializeGuestWorkspace({
    sessionStatus,
    storesHydrated: hydrated,
    workspaceCount,
  })) {
    createWorkspace("My Workspace", "blue");
  }
}, [createWorkspace, hydrated, sessionStatus, workspaceCount]);
```

Remove the old token-boolean reset effect after replacing it with the session-status effect above. Because explicit logout and unauthorized refresh now await `clearDB()` before clearing tokens, the reset occurs only after account data has been removed; the guest effect then seeds a fresh workspace on the next render. The tested `guest → verified` transition returns `false`, so login and registration preserve all guest entities for synchronization.

- [ ] **Step 5: Gate SyncProvider with verified session status**

In `SyncProvider`:

1. Subscribe to `user` with `useAuthStore((s) => s.user)`.
2. Resolve the session status from tokens and `user?.is_verified`.
3. Derive `syncEnabled = canStartSync(sessionStatus, serverUrl)`.
4. Replace the engine effect guard with `if (!syncEnabled || !accessToken) { return; }`.
5. Preserve the current live-credential callback using `useAuthStore.getState()`.
6. Keep effect stability by depending on `[syncEnabled, serverUrl]`, not the access-token string.
7. Fetch plan data when `syncEnabled` becomes true.
8. Define the effective offline state from `sessionStatus === "offline"`.

Use this structure:

```ts
const user = useAuthStore((s) => s.user);
const sessionStatus = resolveAuthSessionStatus({
  accessToken,
  refreshToken,
  isVerified: user?.is_verified ?? null,
});
const syncEnabled = canStartSync(sessionStatus, serverUrl);

useEffect(() => {
  if (syncEnabled) {
    void usePlanStore.getState().fetchPlan();
  }
}, [syncEnabled]);

useEffect(() => {
  if (!syncEnabled || !accessToken) {
    return;
  }

  // Keep the existing settings pull, SyncEngine construction, callbacks,
  // start, and instance-specific cleanup body unchanged here.
}, [syncEnabled, serverUrl]);

const effectiveSyncStatus = useMemo<SyncStatus>(
  () => sessionStatus === "offline" ? "offline" : syncStatus,
  [sessionStatus, syncStatus],
);
```

Do not remove the existing empty-server fallback inside `onPullSuccess`; it still protects authenticated installations whose local database was independently cleared.

- [ ] **Step 6: Always render the dashboard after StoreGate**

Replace the `AuthGate` wrapper in `App` with the existing dashboard tree directly:

```tsx
<StoreGate>
  <QuotaAlert />
  <SyncProvider>
    {(syncStatus, onForceSync, syncErrorMessage) => (
      <HashRouter>
        {/* Keep PageTracker, TabsDndProvider, Routes, and route elements unchanged. */}
      </HashRouter>
    )}
  </SyncProvider>
</StoreGate>
```

Delete `components/auth/auth-page.tsx` after its final import is removed.

- [ ] **Step 7: Run focused and static verification**

Run:

```bash
bun test test/auth-session.test.js test/auth-store-session.test.js
bun run compile
```

Expected: both test files PASS and TypeScript exits with code 0.

- [ ] **Step 8: Commit the always-on dashboard lifecycle**

```bash
git add entrypoints/newtab/App.tsx store/auth-store.ts test/auth-store-session.test.js components/auth/auth-page.tsx
git commit -m "feat: enable offline guest dashboard"
```

---

### Task 3: Build the Single In-Dashboard Authentication Dialog

**Files:**
- Modify: `lib/auth-session.ts`
- Modify: `test/auth-session.test.js`
- Create: `components/auth/auth-dialog.tsx`
- Modify: `components/ui/dialog.tsx:26-53`
- Modify: `components/login-form.tsx:22-43`
- Modify: `components/auth/verify-email-screen.tsx:1-52,160-249`

**Interfaces:**
- Produces: `AuthEntryMode = "login" | "register"`.
- Produces: `resolveAuthDialogPresentation(input): AuthDialogPresentation` with `open`, `view`, and `dismissible`.
- Produces: `AuthDialog({ open, initialMode, onOpenChange })`.
- Produces: `LoginForm({ initialMode?: AuthEntryMode, ...divProps })` while preserving its existing internal mode switches.
- Produces: `VerifyEmailScreen({ email, onUseDifferentAccount })` as embeddable dialog content.

- [ ] **Step 1: Add failing auth-dialog presentation tests**

Add `resolveAuthDialogPresentation` to the existing import from `../lib/auth-session`, then append this test block to `test/auth-session.test.js`:

```js
describe("authentication dialog presentation", () => {
  test("uses a dismissible credentials view for a guest request", () => {
    expect(resolveAuthDialogPresentation({
      requestedOpen: true,
      hasUser: false,
      isVerified: false,
    })).toEqual({
      open: true,
      view: "credentials",
      dismissible: true,
    });
  });

  test("forces a non-dismissible OTP view for an unverified user", () => {
    expect(resolveAuthDialogPresentation({
      requestedOpen: false,
      hasUser: true,
      isVerified: false,
    })).toEqual({
      open: true,
      view: "verify-email",
      dismissible: false,
    });
  });

  test("closes after the user becomes verified", () => {
    expect(resolveAuthDialogPresentation({
      requestedOpen: true,
      hasUser: true,
      isVerified: true,
    })).toEqual({
      open: false,
      view: "credentials",
      dismissible: true,
    });
  });
});
```

Consolidate the imports at the top of the test file so each symbol is imported once.

- [ ] **Step 2: Run the presentation test and verify it fails**

Run:

```bash
bun test test/auth-session.test.js
```

Expected: FAIL because `resolveAuthDialogPresentation` is not exported.

- [ ] **Step 3: Add dialog presentation types and resolver**

Append to `lib/auth-session.ts`:

```ts
export type AuthEntryMode = "login" | "register";
export type AuthDialogView = "credentials" | "verify-email";

interface AuthDialogPresentationInput {
  requestedOpen: boolean;
  hasUser: boolean;
  isVerified: boolean;
}

interface AuthDialogPresentation {
  open: boolean;
  view: AuthDialogView;
  dismissible: boolean;
}

export function resolveAuthDialogPresentation({
  requestedOpen,
  hasUser,
  isVerified,
}: AuthDialogPresentationInput): AuthDialogPresentation {
  if (hasUser && !isVerified) {
    return {
      open: true,
      view: "verify-email",
      dismissible: false,
    };
  }
  if (hasUser && isVerified) {
    return {
      open: false,
      view: "credentials",
      dismissible: true,
    };
  }
  return {
    open: requestedOpen,
    view: "credentials",
    dismissible: true,
  };
}
```

- [ ] **Step 4: Let DialogContent hide its close control**

Replace the current `DialogContent` props shape in `components/ui/dialog.tsx` with:

```tsx
interface DialogContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  showCloseButton?: boolean;
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogContentProps) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 border bg-background p-6 shadow-lg duration-200",
          "data-[state=open]:animate-in data-[state=closed]:animate-out",
          "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          "rounded-lg",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}
```

- [ ] **Step 5: Add LoginForm's initial mode without changing its internal flow**

In `components/login-form.tsx`, replace the private login/register union with Task 3's exported type and add a props interface:

```tsx
import type { AuthEntryMode } from "@/lib/auth-session";

type Mode = AuthEntryMode | "forgot-password" | "reset-password";

interface LoginFormProps extends React.ComponentProps<"div"> {
  initialMode?: AuthEntryMode;
}

export function LoginForm({
  className,
  initialMode = "login",
  ...props
}: LoginFormProps) {
  const { t, language } = useTranslation();
  const [mode, setMode] = React.useState<Mode>(initialMode);
```

Leave `switchMode`, the login/register footer links, forgot-password, reset-password, CAPTCHA checks, error handling, and form `onSubmit` bodies unchanged. This is what permits repeated login/register switching inside the already-open dialog.

- [ ] **Step 6: Convert email verification to embeddable dialog content**

In `components/auth/verify-email-screen.tsx`:

1. Replace the obsolete full-screen/AuthGate comment.
2. Extend the props with `onUseDifferentAccount: () => Promise<void>`.
3. Remove the direct `logout` store selector.
4. Replace the two full-screen wrapper divs with one centered content div.
5. Call the supplied callback from the account-switch button.

The component boundary becomes:

```tsx
interface VerifyEmailScreenProps {
  email: string;
  onUseDifferentAccount: () => Promise<void>;
}

export function VerifyEmailScreen({
  email,
  onUseDifferentAccount,
}: VerifyEmailScreenProps) {
  // Keep all existing OTP, cooldown, CAPTCHA, and error state/effects.

  return (
    <div className="w-full max-w-sm mx-auto">
      <FieldGroup>
        {/* Keep the existing heading, OTP form, resend UI, and nested CAPTCHA dialog. */}
        <FieldDescription className="text-center">
          <button
            type="button"
            className="underline underline-offset-4 hover:text-primary"
            onClick={() => void onUseDifferentAccount()}
          >
            {t("auth_useDifferentAccount")}
          </button>
        </FieldDescription>
      </FieldGroup>
      {/* Keep the existing Prosopo Dialog after FieldGroup. */}
    </div>
  );
}
```

- [ ] **Step 7: Create AuthDialog orchestration**

Create `components/auth/auth-dialog.tsx`:

```tsx
import * as React from "react";
import { LoginForm } from "@/components/login-form";
import { VerifyEmailScreen } from "@/components/auth/verify-email-screen";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  resolveAuthDialogPresentation,
  type AuthEntryMode,
} from "@/lib/auth-session";
import { useAuthStore } from "@/store/auth-store";
import { useTranslation } from "@/hooks/use-translation";

interface AuthDialogProps {
  open: boolean;
  initialMode: AuthEntryMode;
  onOpenChange: (open: boolean) => void;
}

export function AuthDialog({
  open,
  initialMode,
  onOpenChange,
}: AuthDialogProps) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const presentation = resolveAuthDialogPresentation({
    requestedOpen: open,
    hasUser: user !== null,
    isVerified: user?.is_verified ?? false,
  });

  React.useEffect(() => {
    if (open && user?.is_verified) {
      onOpenChange(false);
    }
  }, [onOpenChange, open, user?.is_verified]);

  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    if (!nextOpen && !presentation.dismissible) {
      return;
    }
    onOpenChange(nextOpen);
  }, [onOpenChange, presentation.dismissible]);

  const handleUseDifferentAccount = React.useCallback(async () => {
    await logout();
    onOpenChange(true);
  }, [logout, onOpenChange]);

  const handleBlockedDismiss = React.useCallback((event: Event) => {
    if (!presentation.dismissible) {
      event.preventDefault();
    }
  }, [presentation.dismissible]);

  return (
    <Dialog open={presentation.open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-md max-h-[90svh] overflow-y-auto"
        aria-describedby={undefined}
        showCloseButton={presentation.dismissible}
        onEscapeKeyDown={handleBlockedDismiss}
        onPointerDownOutside={handleBlockedDismiss}
      >
        <DialogTitle className="sr-only">
          {presentation.view === "verify-email"
            ? t("auth_checkEmail")
            : initialMode === "register"
              ? t("auth_registerTitle")
              : t("auth_loginTitle")}
        </DialogTitle>
        {presentation.view === "verify-email" && user ? (
          <VerifyEmailScreen
            email={user.email}
            onUseDifferentAccount={handleUseDifferentAccount}
          />
        ) : (
          <LoginForm key={initialMode} initialMode={initialMode} />
        )}
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 8: Run focused tests and TypeScript verification**

Run:

```bash
bun test test/auth-session.test.js
bun run compile
```

Expected: PASS and TypeScript exits with code 0. If Radix types expose a narrower event type, let TypeScript infer it inline instead of adding an assertion or `any`.

- [ ] **Step 9: Commit the reusable dialog flow**

```bash
git add lib/auth-session.ts test/auth-session.test.js components/auth/auth-dialog.tsx components/ui/dialog.tsx components/login-form.tsx components/auth/verify-email-screen.tsx
git commit -m "feat: move authentication into a dialog"
```

---

### Task 4: Add Guest Sidebar Entry Points and Localized Copy

**Files:**
- Create: `test/auth-i18n.test.js`
- Modify: `public/_locales/en/messages.json:263-320`
- Modify: `public/_locales/zh_CN/messages.json:263-320`
- Modify: `components/dashboard/sidebar/user-profile.tsx:1-206`
- Modify: `components/dashboard/sidebar/sync-status.tsx:1-66`
- Modify: `components/dashboard/sidebar/index.tsx:168-253,493-535`

**Interfaces:**
- Consumes: `AuthDialog` and `AuthEntryMode` from Task 3.
- Produces: `UserProfile({ onLogin })` with authenticated and guest presentations.
- Produces: `SyncStatusIndicator({ isGuest, onRegister, status, errorMessage, onForceSync })`.
- Produces: top login and bottom registration entry points into the same controlled dialog.

- [ ] **Step 1: Write failing locale-contract tests**

Create `test/auth-i18n.test.js`:

```js
import { describe, expect, test } from "bun:test";
import en from "../public/_locales/en/messages.json";
import zhCN from "../public/_locales/zh_CN/messages.json";

describe("guest authentication locale messages", () => {
  test("defines English guest profile and sync actions", () => {
    expect(en.sidebar_guestTitle.message).toBe("Not logged in");
    expect(en.sidebar_guestDescription.message).toBe("Log in or register to sync");
    expect(en.sync_signedOut.message).toBe("Not logged in");
    expect(en.sync_registerNow.message).toBe("Register now");
  });

  test("defines Chinese guest profile and sync actions", () => {
    expect(zhCN.sidebar_guestTitle.message).toBe("未登录");
    expect(zhCN.sidebar_guestDescription.message).toBe("登录或注册以启用同步");
    expect(zhCN.sync_signedOut.message).toBe("未登录");
    expect(zhCN.sync_registerNow.message).toBe("立即注册");
  });
});
```

- [ ] **Step 2: Run the locale test and verify it fails**

Run:

```bash
bun test test/auth-i18n.test.js
```

Expected: FAIL because the four keys are absent in each locale.

- [ ] **Step 3: Add exact English and Chinese messages**

Add these entries to `public/_locales/en/messages.json`:

```json
"sidebar_guestTitle": {
  "message": "Not logged in"
},
"sidebar_guestDescription": {
  "message": "Log in or register to sync"
},
"sync_signedOut": {
  "message": "Not logged in"
},
"sync_registerNow": {
  "message": "Register now"
}
```

Add these entries to `public/_locales/zh_CN/messages.json`:

```json
"sidebar_guestTitle": {
  "message": "未登录"
},
"sidebar_guestDescription": {
  "message": "登录或注册以启用同步"
},
"sync_signedOut": {
  "message": "未登录"
},
"sync_registerNow": {
  "message": "立即注册"
}
```

- [ ] **Step 4: Render a guest profile without conditional hooks**

In `components/dashboard/sidebar/user-profile.tsx`:

1. Add `UserRound` to the icon imports.
2. Add `interface UserProfileProps { onLogin: () => void; }`.
3. Extract the current authenticated card into a private `AuthenticatedUserProfile` component so its `useMemo` hook is never conditionally skipped.
4. Make the exported `UserProfile` select only `user`, return the guest button when `user === null`, and otherwise render `AuthenticatedUserProfile`.

The guest branch must be:

```tsx
interface UserProfileProps {
  onLogin: () => void;
}

function GuestUserProfile({ onLogin }: UserProfileProps) {
  const { t } = useTranslation();

  return (
    <div className="px-3 py-4">
      <button
        type="button"
        onClick={onLogin}
        className="w-full flex items-center gap-3 p-2.5 rounded-xl border bg-sidebar-accent/40 hover:bg-sidebar-accent text-left transition-colors"
      >
        <div className="size-8.5 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
          <UserRound className="size-4" />
        </div>
        <div className="flex flex-1 flex-col truncate">
          <span className="text-sm font-semibold leading-none">
            {t("sidebar_guestTitle")}
          </span>
          <span className="text-[11px] text-muted-foreground truncate mt-1 leading-none">
            {t("sidebar_guestDescription")}
          </span>
        </div>
        <ChevronRight className="size-4 text-muted-foreground/50" />
      </button>
    </div>
  );
}

export function UserProfile({ onLogin }: UserProfileProps) {
  const user = useAuthStore((s) => s.user);
  if (!user) {
    return <GuestUserProfile onLogin={onLogin} />;
  }
  return <AuthenticatedUserProfile user={user} />;
}
```

Move the existing `logout` and `subscription` selectors into `AuthenticatedUserProfile`; preserve its current card, dropdown, quota, import, and logout behavior.

- [ ] **Step 5: Add guest behavior to SyncStatusIndicator**

Extend `SyncStatusProps` with `isGuest: boolean` and `onRegister: () => void`. Import `UserPlus`, then add this early return after `useTranslation()`:

```tsx
if (isGuest) {
  return (
    <div className="flex items-center gap-3 px-2 py-1">
      <div
        className="flex items-center gap-1.5 text-xs text-muted-foreground w-24 shrink-0"
        aria-label={t("sync_signedOut")}
      >
        <span className="w-2 h-2 rounded-full shrink-0 bg-muted-foreground/50" aria-hidden="true" />
        <span className="truncate">{t("sync_signedOut")}</span>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onRegister}
        aria-label={t("sync_registerNow")}
        className="h-6 px-2 text-xs"
      >
        <UserPlus className="size-3" />
        {t("sync_registerNow")}
      </Button>
    </div>
  );
}
```

Leave the four existing sync states and error tooltip unchanged for non-guests.

- [ ] **Step 6: Wire both sidebar controls to one AuthDialog**

In `components/dashboard/sidebar/index.tsx`:

1. Import `AuthDialog`, `AuthEntryMode`, and `useAuthStore`.
2. Leave the existing collection comparison intact; Task 5 replaces it independently.
3. Add separate access-token and refresh-token selectors and derive `isGuest` without subscribing to the whole store.
4. Add `authDialogOpen` and `authEntryMode` local state.
5. Add stable callbacks that set the desired mode before opening.

Use:

```tsx
const accessToken = useAuthStore((s) => s.accessToken);
const refreshToken = useAuthStore((s) => s.refreshToken);
const isGuest = accessToken === null && refreshToken === null;
const [authDialogOpen, setAuthDialogOpen] = React.useState(false);
const [authEntryMode, setAuthEntryMode] = React.useState<AuthEntryMode>("login");

const handleOpenLogin = React.useCallback(() => {
  setAuthEntryMode("login");
  setAuthDialogOpen(true);
}, []);

const handleOpenRegistration = React.useCallback(() => {
  setAuthEntryMode("register");
  setAuthDialogOpen(true);
}, []);
```

Replace the profile call with:

```tsx
<UserProfile onLogin={handleOpenLogin} />
```

Make bottom padding reflect the missing guest quota card:

```tsx
<SidebarContent className={cn("px-3 pt-3", isGuest ? "pb-24" : "pb-72")}>
```

Replace the overlay contents with:

```tsx
{!isGuest && (
  <div className="pointer-events-auto">
    <QuotaCard />
  </div>
)}
<div className="pointer-events-auto px-2">
  <SyncStatusIndicator
    status={syncStatus}
    errorMessage={syncErrorMessage}
    onForceSync={onForceSync}
    isGuest={isGuest}
    onRegister={handleOpenRegistration}
  />
</div>
```

Render the shared dialog beside the existing collection/tag/group dialogs:

```tsx
<AuthDialog
  open={authDialogOpen}
  initialMode={authEntryMode}
  onOpenChange={setAuthDialogOpen}
/>
```

- [ ] **Step 7: Run locale and compile verification**

Run:

```bash
bun test test/auth-i18n.test.js test/auth-session.test.js
bun run compile
```

Expected: tests PASS and TypeScript exits with code 0.

- [ ] **Step 8: Commit the complete sidebar authentication entry flow**

```bash
git add test/auth-i18n.test.js public/_locales/en/messages.json public/_locales/zh_CN/messages.json components/dashboard/sidebar/user-profile.tsx components/dashboard/sidebar/sync-status.tsx components/dashboard/sidebar/index.tsx
git commit -m "feat: add guest authentication actions"
```

---

### Task 5: Canonicalize Active Collection Ordering

**Files:**
- Create: `lib/collection-utils.ts`
- Create: `test/collection-utils.test.js`
- Modify: `components/dashboard/content.tsx:1-31,288-291`
- Modify: `components/dashboard/sidebar/index.tsx:1-61,212-223`
- Modify: `components/dashboard/add-bookmark-dialog.tsx:1-49`
- Modify: `components/dashboard/groups-panel/droppable-group-card.tsx:1-80`
- Modify: `components/dashboard/group-detail/index.tsx:1-84`
- Modify: `components/dashboard/tab-row.tsx:1-70`
- Modify: `components/dashboard/import-dialog.tsx:1-192`
- Modify: `entrypoints/popup/App.tsx:1-90`
- Modify: `store/workspace-store.ts:1-15,754-764`

**Interfaces:**
- Produces: `compareActiveCollections(left: SortableCollection, right: SortableCollection): number`.
- All active collection renderers and selectors consume the same comparator after lifecycle/workspace filtering.

- [ ] **Step 1: Write the failing comparator test**

Create `test/collection-utils.test.js`:

```js
import { describe, expect, test } from "bun:test";
import { compareActiveCollections } from "../lib/collection-utils";

describe("active collection ordering", () => {
  test("pins Default first and orders remaining collections by descending position", () => {
    const collections = [
      { id: "old", isDefault: false, position: 1 },
      { id: "default", isDefault: true, position: 0 },
      { id: "newest", isDefault: false, position: 9 },
      { id: "middle", isDefault: false, position: 4 },
    ];

    const sortedIds = [...collections]
      .sort(compareActiveCollections)
      .map((collection) => collection.id);

    expect(sortedIds).toEqual(["default", "newest", "middle", "old"]);
  });
});
```

- [ ] **Step 2: Run the test and verify the missing-module failure**

Run:

```bash
bun test test/collection-utils.test.js
```

Expected: FAIL because `lib/collection-utils.ts` does not exist.

- [ ] **Step 3: Implement the canonical comparator**

Create `lib/collection-utils.ts`:

```ts
interface SortableCollection {
  isDefault?: boolean;
  position: number;
}

export function compareActiveCollections(
  left: SortableCollection,
  right: SortableCollection,
): number {
  if (left.isDefault) {
    return -1;
  }
  if (right.isDefault) {
    return 1;
  }
  return right.position - left.position;
}
```

The structural input intentionally lets unit tests and any collection-shaped view model call the function without assertions.

- [ ] **Step 4: Replace every duplicated active collection comparison**

Import `compareActiveCollections` from `@/lib/collection-utils` and replace only the active-collection comparator body with:

```ts
.sort(compareActiveCollections)
```

Apply this exact replacement in:

- `components/dashboard/content.tsx` — fixes the reported ascending-order bug in grouped All Bookmarks.
- `components/dashboard/sidebar/index.tsx` — keeps the sidebar on the shared source of truth.
- `components/dashboard/add-bookmark-dialog.tsx`.
- `components/dashboard/groups-panel/droppable-group-card.tsx`.
- `components/dashboard/group-detail/index.tsx`.
- `components/dashboard/tab-row.tsx`.
- `components/dashboard/import-dialog.tsx`.
- `store/workspace-store.ts` in `getWorkspaceCollections`.

Do not change tab ordering, workspace ordering, bookmark ordering, or archived/trashed collection ordering.

- [ ] **Step 5: Bring the popup's active collections under the same rule**

In `entrypoints/popup/App.tsx`, import the comparator and replace the unsorted collection load with:

```ts
const cols = state.collections
  .filter((collection) =>
    collection.workspaceId === state.activeWorkspaceId &&
    !collection.deletedAt &&
    !collection.archivedAt
  )
  .sort(compareActiveCollections);
```

Keep `setSelectedCollectionId(cols[0].id)` so the canonical first/default collection remains the initial selection.

- [ ] **Step 6: Run focused tests and static analysis**

Run:

```bash
bun test test/collection-utils.test.js
bun run compile
```

Expected: PASS and TypeScript exits with code 0.

- [ ] **Step 7: Commit collection ordering**

```bash
git add lib/collection-utils.ts test/collection-utils.test.js components/dashboard/content.tsx components/dashboard/sidebar/index.tsx components/dashboard/add-bookmark-dialog.tsx components/dashboard/groups-panel/droppable-group-card.tsx components/dashboard/group-detail/index.tsx components/dashboard/tab-row.tsx components/dashboard/import-dialog.tsx entrypoints/popup/App.tsx store/workspace-store.ts
git commit -m "fix: unify active collection ordering"
```

---

### Task 6: Update Lifecycle Documentation and Run Full Verification

**Files:**
- Modify: `CLAUDE.md` in the `AuthGate`, `StoreGate`, and SyncEngine lifecycle guidance.

**Interfaces:**
- Consumes: all completed implementation tasks.
- Produces: repository guidance that matches the shipped guest/AuthDialog behavior.

- [ ] **Step 1: Update the existing authentication guidance**

Replace the obsolete full-screen `AuthGate` paragraph in `CLAUDE.md` with an exact description of:

- Dashboard rendering after StoreGate for guests and authenticated users.
- Empty guest workspace initialization.
- Sidebar top login and bottom registration entry points.
- Internal login/register/forgot/reset switching inside `AuthDialog`.
- Forced, non-dismissible OTP content inside the same dialog.
- Guest data remaining `seq === 0` and merging after verification.
- Verified-only SyncEngine startup.
- Logout/unauthorized-refresh clearing account data before fresh guest initialization.

Keep the existing CAPTCHA, OTP, storage, and SyncEngine cleanup constraints; only update statements invalidated by this implementation.

- [ ] **Step 2: Run the complete automated test suite**

Run:

```bash
bun test
```

Expected: all existing and new tests PASS with zero failures.

- [ ] **Step 3: Run TypeScript static analysis**

Run:

```bash
bun run compile
```

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 4: Run the production build**

Run:

```bash
bun run build
```

Expected: exit code 0 and a production Chrome MV3 extension in `.output/chrome-mv3`.

- [ ] **Step 5: Perform the Chrome extension acceptance pass**

Load `.output/chrome-mv3` as an unpacked extension and verify this exact sequence:

1. Clear extension storage, open a new tab, and confirm the dashboard appears with one workspace and Default collection.
2. Create a guest collection and bookmark while the backend is unavailable; reload and confirm both persist.
3. Confirm the sidebar top and bottom both display “Not logged in” / “未登录”.
4. Click the top control and confirm login opens in a Dialog.
5. Switch Login → Register → Login inside the same Dialog without closing it.
6. Close the Dialog, click “Register now”, and confirm it opens directly in registration mode.
7. Exercise Forgot password and return to Login without leaving the Dialog.
8. Register or log in as an unverified user; confirm the same Dialog changes to OTP and cannot close via X, Escape, or outside click.
9. Complete OTP; confirm the Dialog closes, guest entities remain, and synchronization starts.
10. Confirm Content and Sidebar show Default first and all remaining collections in identical descending-position order.
11. Disconnect the backend for a verified persisted session; confirm the profile remains visible and sync shows Offline.
12. Log out; confirm account data disappears and a fresh guest workspace is created.

- [ ] **Step 6: Inspect the final diff for scope and safety**

Run:

```bash
git diff --check
git status --short
git diff --stat HEAD~5..HEAD
```

Confirm there are no unrelated changes, no generated build output staged, no new non-Superpowers Markdown file, and no edits to API/rate-limit/CAPTCHA semantics.

- [ ] **Step 7: Commit documentation and any verification-only corrections**

```bash
git add CLAUDE.md
git commit -m "docs: describe offline authentication lifecycle"
```

If verification required a code correction, rerun the affected focused test, `bun test`, `bun run compile`, and `bun run build`, then include the corrected source and its regression test in this final commit.
