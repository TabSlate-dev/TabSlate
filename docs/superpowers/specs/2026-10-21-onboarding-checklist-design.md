# Onboarding Checklist (Sub-project E)

## Summary

A new TabSlate user sees an empty "Default" collection and one line of text. The features that set TabSlate apart are hard to find on their own: dragging open tabs into collections, saving a whole window as a collection, the search overlay on web pages (which also needs an optional permission), the save shortcut, importing bookmarks, and syncing across devices.

This sub-project adds a "Getting started" checklist at the top of the bookmark list for new installs. It has six steps. Each step has a button that starts the action or shows where it happens, and each step checks itself off when the user does it. The checklist writes no sample data, so the guest workspace logic is unchanged.

## Roadmap Context

This is the sixth sub-project derived from the faved.to comparison (see `docs/superpowers/specs/2026-10-15-library-management-basics-design.md`). Each has its own spec, plan, and implementation cycle.

| Sub-project | Scope | Repositories |
|---|---|---|
| A — Library management basics | View preferences, tag and collection editing, counts, tag search, clickable tags, save shortcut, duplicate detection | Frontend |
| B — Bulk operations and unified form | Multi-select and bulk bar, unified add/edit form, notes, edit time, more sort options | Frontend + server |
| C1 — Image card view | Small and large card views, `og:image` covers read at save time, placeholders | Frontend + server (one field) |
| C2 — Web snapshots | Server-side page capture, snapshot viewer, full-page archives on demand, snapshot full-text search, storage quota | Server + cloud + frontend |
| D — Nested tags and import hierarchy | Tag hierarchy, parent rollups, tag tree in the sidebar, folder hierarchy preserved on import | Frontend + server |
| **E — Onboarding** (this spec) | First-run checklist for new installs | Frontend |

The roadmap first planned onboarding as seed content plus guided steps. faved does it with a three-step welcome and a set of tutorial bookmarks and sample tags. TabSlate discards an untouched guest workspace when the user signs into an existing account, and a workspace with bookmarks no longer counts as untouched. Sample content would therefore need special handling so it does not end up in the user's account. A checklist teaches the same features by having the user try them, with no data to clean up.

**Depends on A.** The checklist reuses A's way of reading the bound save shortcut. It does not depend on B, C, or D; if D lands first, the import step opens D's import dialog unchanged.

## Goals

- Show new users what TabSlate can do and get them to try each feature once.
- Make the search overlay's optional permission understandable and easy to grant.
- Check steps off automatically when the user does them, whichever way they do them.
- Stay out of the way: collapsible, dismissible, and absent for existing users.

## Non-goals

- Sample bookmarks, collections, or tags.
- Guided tours with popovers that walk across the interface.
- A welcome page or a welcome dialog.
- Syncing onboarding progress between devices.
- Showing the checklist automatically to existing users after an update.
- Steps for C2 snapshots or other paid features.

## Decisions

| Question | Decision |
|---|---|
| Form | A checklist card at the top of the main bookmark list. |
| Sample content | None. |
| Who sees it | New installs only, plus anyone who reopens it from Settings. |
| Completion | Steps check off automatically from the user's actions and stay checked. |
| State | Stored per device in IndexedDB; not synced. |
| First open | The background opens a new tab after installation. |

## Design

### 1. When the checklist appears

- On `chrome.runtime.onInstalled` with `reason === "install"`, the background creates the onboarding record (section 4) and opens a new tab, which shows the TabSlate new tab page. Chrome then asks, as usual, whether to keep the extension's new tab page. Failures to open the tab are ignored.
- Updates never create the record, so existing users do not see the checklist.
- Anyone can show the checklist again from Settings → General → "Show the getting started guide". This creates the record if it is missing (for example after logout cleared the database, or for an existing user) and makes the checklist visible; completed steps stay checked.

### 2. The card

- **Placement.** At the top of the main bookmark list (`/`, `BookmarksContent`), above the collections, scrolling with the list. Other routes do not show it.
- **Header.** "Get started with TabSlate", the progress ("2/6"), a collapse control, and a close button (✕).
- **Collapsing.** Clicking the header collapses the card to one line, "Get started 2/6". The collapsed state is remembered.
- **Closing.** ✕ hides the checklist without asking.
- **All done.** When all six steps are checked, the card shows "You're all set" with a close button. On the next new tab the checklist no longer appears.
- **Layout.** Each step is a row with a check state, a title, a one-line explanation, and an action button where the step has one. Completed steps keep their row with the check and without the button.

### 3. Steps

| Step | ID | Completes when | Action |
|---|---|---|---|
| Save your first bookmark | `save_bookmark` | The library has any bookmark (active, archived, or trashed), however it got there, including imports and sync | No button. The explanation lists the three ways to save: the save shortcut (the bound keys, read with `findSaveShortcut`), the "Save to TabSlate" context-menu item, and dragging tabs. |
| Drag a tab into a collection | `drag_tab` | The first time open tabs are dropped on a collection and saved (`tabs-dnd-provider.tsx`) | "Show me": on wide windows (the tabs rail is visible at `lg` and up), the tabs rail and the sidebar's collection rows pulse for 5 seconds with a short tip; on narrower windows it opens the tabs page (`/tabs`). |
| Save a whole window | `save_window` | The first successful `saveWindowAsCollection` or `saveGroupAsCollection` | "Do it": opens the tabs page with the "Save window" dialog open (passed through router state, which `TabsPanel` reads once on mount). |
| Turn on the search overlay | `search_overlay` | The first time the overlay opens on a web page: the background marks it when it accepts a `REGISTER_SEARCH_OVERLAY_SESSION` | Without the optional all-sites permission: "Allow", which requests it inside the click handler, the same request as the Settings switch. With it: "Press «shortcut» on any web page", with the keys bound to `open-search`. When no keys are bound, the explanation says where to set them (Chrome: a button that opens `chrome://extensions/shortcuts`; Firefox: text pointing to the add-ons manager's shortcut settings). |
| Import your bookmarks | `import` | The first successful import (`importFromPlan` returns true in the import dialog) | "Import": dispatches `tabslate-open-import`. |
| Sign up to sync | `sign_in` | The session is verified (signed in with a verified email) | "Sign up / Log in": dispatches a new `tabslate-open-auth` event with `{ mode: "register" }`; the sidebar, which owns `AuthDialog`, opens it in that mode. The dialog's existing link switches to logging in. |

- Steps stay checked once complete, even if the condition stops holding (for example after deleting every bookmark).
- `save_bookmark` and `sign_in` are derived from data the new tab page already has; the page records them when it sees them true. A user who installs and signs into an existing account gets both checked once the library syncs.
- The background records `search_overlay`, because the overlay opens on web pages. The new tab page reads the record again when it becomes visible, so the step updates when the user returns.

### 4. State

`lib/onboarding.ts` owns the IndexedDB `kv` record `onboarding-v1`:

```ts
interface OnboardingState {
  version: 1;
  visible: boolean;
  collapsed: boolean;
  completed: Partial<Record<OnboardingStepId, number>>; // Unix ms
}
```

- Helpers read the record, mark a step complete (a no-op when the record is missing or the step is already complete), and set visibility and collapse. Each write is a read-modify-write in one IndexedDB transaction, so the background and an open new tab cannot overwrite each other's steps.
- The module imports no stores, so the background can use it.
- A missing record means no checklist.
- The record is per device and is not synced. Logout clears IndexedDB, and with it the checklist.
- A `useOnboarding()` hook in the new tab page loads the record, re-reads it on `visibilitychange` to visible and after its own writes, and records the derived steps.

### 5. Permission and shortcut helpers

- `lib/browser/site-access.ts` exports `hasAllSitesAccess()`, `requestAllSitesAccess()`, and `removeAllSitesAccess()`, moved out of the Settings dialog's search overlay switch. The switch and the checklist share them. The request must run inside the click handler before any `await`, as Firefox requires.
- `lib/browser/commands.ts` adds `findSearchShortcut(commands)` next to A's `findSaveShortcut`.

### 6. Analytics

The existing anonymous analytics client records `onboarding_step_completed` (with the step ID), `onboarding_dismissed` (with the number of completed steps), and `onboarding_completed`. Firefox builds send nothing, as today. No bookmark data is included.

## Components and Files

New:

- `lib/onboarding.ts` — the state type, step IDs, and record helpers.
- `lib/browser/site-access.ts` — the all-sites permission helpers.
- `hooks/use-onboarding.ts` — loading, refreshing, and derived steps for the new tab page.
- `components/dashboard/onboarding/onboarding-checklist.tsx` — the card and its step rows.

Modified:

- `entrypoints/background.ts` — create the record and open a new tab on install; mark `search_overlay` on overlay registration.
- `components/dashboard/content.tsx` — render the checklist at the top of the main list.
- `components/dashboard/tabs-dnd-provider.tsx` — mark `drag_tab`.
- `components/dashboard/tabs-panel/index.tsx`, `tabs-panel/group-card.tsx` — mark `save_window`; open the Save window dialog from router state.
- `components/dashboard/tabs-rail.tsx`, `components/dashboard/sidebar/` — the 5-second highlight for "Show me"; the sidebar handles `tabslate-open-auth`.
- `components/dashboard/import-dialog.tsx` — mark `import`.
- `components/dashboard/settings-dialog.tsx` — use the site-access helpers; add "Show the getting started guide".
- `lib/browser/commands.ts` — `findSearchShortcut`.
- both `messages.json`, `CLAUDE.md` (the `onboarding-v1` key, the `tabslate-open-auth` event, the install behavior), `ARCHITECTURE.md`.

## Error Handling

- IndexedDB errors hide the checklist and never block the page or the actions that mark steps.
- A denied permission request leaves the search overlay step unchecked, and the "Allow" button stays.
- A failure to open the new tab on install is ignored.
- Marking a step never throws into the action that triggered it.

## Testing

Each behavior is implemented test-first, with the happy-dom helpers and module save-and-restore pattern from A.

- **Unit tests:** reading and writing the record, including steps staying checked and the missing-record no-op; the background's install handler creating the record and opening a tab, while updates do neither; marking each step from its trigger (tab drops, saving a window, saving a group, importing, overlay registration) and from derived state (bookmarks, verified session); `findSearchShortcut`; the site-access helpers on Chromium and Firefox.
- **Component tests:** showing, collapsing, closing, reopening from Settings, and the all-done state; each action button, including both "Show me" layouts, the permission request in the click handler, and the unbound-shortcut explanation; no checklist without a record.
- **Manual check:** a fresh install in Chrome and in Firefox, going through all six steps, including granting the permission and opening the overlay on a web page.

## Accessibility and Internationalization

- The card is a `section` with a heading; the steps are a list. Completed steps expose "Completed" to screen readers, and every button has a specific label.
- The collapse control uses `aria-expanded`.
- The highlight in "Show me" is visual only; the tip text is also announced through `role="status"`.
- Every new string is translated in English and Simplified Chinese with `[component]_[description]` keys.

## Resolved During Design

- **A checklist instead of sample content.** Sample bookmarks and tags would make the auto-created guest workspace look "touched", so the sign-in reconciliation would need to recognize and discard unchanged samples, including global sample tags. A checklist teaches the same features without data to reconcile or clean up.
- **Per-device state.** Granting the overlay permission and binding shortcuts are per-browser anyway, and syncing a short-lived checklist adds sync surface for little benefit.
- **New installs only.** Existing users already know the basics; the Settings entry lets anyone reopen the checklist.
