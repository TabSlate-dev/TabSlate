# Offline Authentication Dialog and Collection Ordering Design

## Summary

TabSlate will open directly into the functional dashboard for users without an account session. Authentication becomes an in-dashboard dialog opened from the sidebar, while the existing login, registration, password recovery, CAPTCHA, OTP cooldown, rate-limit handling, and self-hosted server configuration flows remain intact.

Guest data stays local with `seq === 0`. After successful authentication and email verification, the existing sync engine merges server data and uploads the guest data to the selected account. Active collections use one shared ordering rule everywhere: the default collection first, then other collections by descending `position`.

## Goals

- Allow a newly installed extension to be used offline without showing a standalone authentication page.
- Show a clear signed-out state at both the top and bottom of the sidebar.
- Open login and registration inside one reusable dialog.
- Allow login and registration forms to switch inside the open dialog without requiring another sidebar click.
- Keep password recovery, password reset, CAPTCHA, OTP verification, cooldowns, and rate-limit behavior inside the same dialog flow.
- Preserve guest data and merge it into the authenticated account.
- Start remote synchronization only for verified users with a valid access token.
- Make active collection ordering consistent across Content, Sidebar, and collection selectors.

## Non-goals

- No backend API or rate-limiter changes.
- No changes to authentication request payloads or token storage.
- No new guest account or server-side guest identity.
- No change to the existing account logout policy: account data is cleared locally on logout.
- No redesign of the existing login, registration, CAPTCHA, OTP, or password-reset forms beyond adapting them to dialog composition.

## Current State and Root Causes

### Authentication

`AuthGate` in `entrypoints/newtab/App.tsx` replaces the dashboard with `AuthPage` when both tokens are absent. It also replaces the dashboard with `VerifyEmailScreen` when the current user is unverified. Because `SyncProvider` is nested inside `AuthGate`, an unverified user cannot start synchronization.

`UserProfile` returns nothing when `user` is absent, and `SyncStatusIndicator` only understands sync-engine states. There is therefore no guest call to action in either sidebar location.

A completely empty IndexedDB is currently seeded only after the first successful pull for a new account. A guest installation therefore needs a separate local seed path before authentication.

### Collection ordering

The sidebar implements the documented ordering rule:

1. Default collection first.
2. Remaining collections by descending `position`.

The grouped All Bookmarks view in `components/dashboard/content.tsx` instead sorts all active collections by ascending `position`. The duplicated comparison logic allowed the two surfaces to drift.

## Authentication Architecture

### Dashboard and store gates

`StoreGate` remains responsible for hydrating local stores. `AuthGate` no longer controls dashboard rendering; the dashboard always renders after hydration.

After all required stores are hydrated, a guest session with no local workspaces creates exactly one local workspace named `My Workspace` and its default collection. The normal workspace action persists both entities with `seq === 0`, so the dashboard is immediately functional and the data is eligible for later synchronization.

Session states are interpreted as follows:

- Guest: no access token and no refresh token. Show the guest sidebar state and do not start remote sync.
- Signed in but temporarily offline: a verified persisted user and refresh token exist, but access-token refresh cannot currently reach the server. Keep the user profile visible and expose the existing offline/retry sync behavior.
- Unverified: a user exists with `is_verified === false`. Keep the dashboard mounted, force the authentication dialog to its OTP step, and do not start remote sync.
- Verified: the user is verified and a valid access token exists. Start the existing sync engine.

### AuthDialog

A single controlled `AuthDialog` is rendered outside the sidebar panel to avoid clipping and z-index problems. `BookmarksSidebar` owns its open state and requested initial mode because both entry points are inside the sidebar.

The entry points are:

- Sidebar top guest profile: open the dialog in login mode.
- Sidebar bottom call to action: open the dialog in registration mode.

`LoginForm` accepts an initial mode, but retains its existing internal mode state. Its current login/register links continue to switch forms without closing the dialog. Forgot-password and reset-password remain internal modes of the same component and dialog.

When login or registration returns an unverified user, `AuthDialog` replaces `LoginForm` with the OTP verification content without closing. During OTP verification, outside clicks, Escape, and the close button cannot dismiss the dialog. “Use a different account” performs the existing logout behavior and returns the same dialog to login mode.

When a verified login succeeds, or OTP verification changes `user.is_verified` to `true`, the dialog closes automatically. The dashboard was already mounted, so authentication does not cause navigation or discard UI data.

### Form behavior and accessibility

The existing `onSubmit` handlers remain in place so failed requests preserve uncontrolled input values. Existing API error display, CAPTCHA refresh, CAPTCHA status checks, OTP auto-submit, resend cooldowns, password requirements, and server URL controls are reused unchanged.

The dialog uses the standard shadcn structure and includes an accessible title. Normal authentication modes are dismissible. The forced OTP mode is explicitly non-dismissible until verification or account switching.

## Offline Data and Session Transitions

Guest-created workspaces, collections, bookmarks, tags, and groups stay in IndexedDB with `seq === 0`. Authentication success does not reset any local data.

Once the user is verified, `SyncProvider` starts:

- If the account is empty, the existing initial-push path enqueues all local entities.
- If the account already contains data, server entities merge locally and the existing `sweepUnsynced()` calls enqueue all remaining guest entities.

This preserves both server and guest data rather than replacing either side.

Explicit logout keeps the current privacy behavior: revoke tokens on a best-effort basis, clear IndexedDB and account-specific cached state, then transition to guest mode. Guest initialization creates a fresh empty workspace after the clear completes.

An invalid refresh token is also an authenticated-to-guest transition. Account data must be cleared before guest initialization so stale account data cannot reappear after a reload or be uploaded to another account.

## Sidebar Presentation

### Top profile

Authenticated users keep the existing profile card and menu. Guests see a visually compatible button with:

- Primary label: “Not logged in” / “未登录”.
- Supporting text explaining that login or registration enables synchronization.
- A click action that opens `AuthDialog` in login mode.

### Bottom status

Authenticated users keep the existing sync status and “Sync now” behavior. Guests see:

- Status label: “Not logged in” / “未登录”.
- Action button: “Register now” / “立即注册”.
- A click action that opens `AuthDialog` in registration mode.

The quota card is hidden for guests, and guest mode does not request plan information. Local create operations continue to work when no plan limits are loaded.

## Sync Safety

`SyncProvider` creates an engine only when all of the following are true:

- `serverUrl` is configured.
- `accessToken` exists.
- `user.is_verified === true`.

This preserves the current rule that unverified accounts cannot synchronize. A verified user with a refresh token but no access token retains the current offline status and “Sync now” retry behavior.

The existing engine cleanup order remains unchanged: best-effort `forceSync()`, instance `destroy()`, then `releaseSyncEngine(engine)`. The implementation must not call `destroySyncEngine()` from the provider cleanup.

## Collection Ordering

A shared pure comparator defines active collection ordering:

```ts
if (a.isDefault) return -1;
if (b.isDefault) return 1;
return b.position - a.position;
```

Content, Sidebar, and existing active-collection selectors use this comparator after workspace and lifecycle filtering. Derived arrays remain inside `useMemo`; selectors continue to return raw store fields to avoid unstable references and render loops.

The grouped All Bookmarks view therefore renders collections in exactly the same order as the sidebar. Uncategorized bookmarks remain after all named collections and are not part of the active-collection comparator.

## Error Handling

- Authentication errors remain inside the dialog and do not affect offline data.
- Failed login or registration does not close the dialog or clear form inputs.
- CAPTCHA-required and HTTP 429 responses continue through the existing handlers.
- OTP resend keeps the existing local cooldown and server-enforced rate limit.
- Network loss during token refresh preserves the signed-in offline state because the refresh token remains present.
- An unauthorized refresh clears account data before switching to a fresh guest workspace.
- Sync failures retain the existing sidebar error/offline presentation for authenticated users.

## Testing and Verification

Automated tests will cover:

- The shared collection comparator: default first and descending `position` for all other collections.
- The grouped Content order matching the sidebar order.
- Guest initialization creating one workspace/default collection only when both the session and local workspace list are empty.
- Guest initialization not running for a persisted authenticated session.
- Authentication state gating sync so guests and unverified users cannot start an engine.
- Guest data remaining present through login and being eligible for `sweepUnsynced()`.
- Logout and invalid-session transitions clearing account data before creating a fresh guest workspace.
- Pure authentication-session classification and dialog mode-transition rules. Component integration is additionally verified by TypeScript compilation and the production build.

Final verification commands:

```bash
bun test
bun run compile
bun run build
```

## Acceptance Criteria

- A fresh installation opens the dashboard without an authentication page.
- A guest can create and manage local TabSlate data without network access.
- Both guest sidebar locations display “Not logged in” / “未登录”.
- The top guest control opens login; the bottom action opens registration.
- Login and registration switch inside the same open dialog.
- Password recovery, reset, CAPTCHA, OTP verification, and account switching stay inside that dialog flow.
- Unverified accounts cannot dismiss OTP verification or start sync.
- Verified authentication closes the dialog and merges/uploads guest data.
- Logout returns to a fresh usable guest workspace without exposing the prior account's data.
- Content collection groups and the sidebar show the same canonical order.
- Existing authentication endpoints, rate limits, CAPTCHA rules, and sync cleanup constraints are unchanged.
