# Auth Dialog Blur and Browser Regression Repairs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the authentication dialog a frosted background and make the project's full automated suite green by repairing the three known browser-related regressions.

**Architecture:** `DialogContent` gains an optional overlay class so a caller can opt into a visual effect without changing shared dialog defaults. The browser repairs keep source and tests aligned with the intended platform behavior: Edge reuses Chrome packaging, Firefox declares its actual minimum version, and Firefox does not use Chromium-only session access levels.

**Tech Stack:** TypeScript, React, Radix Dialog, WXT, Bun test, Node.js packaging scripts.

## Global Constraints

- Do not create Markdown files outside the Superpowers specification and plan workflow.
- Use strict TypeScript, named React exports, and existing shadcn Dialog structure.
- Preserve authentication, OTP, CAPTCHA, and rate-limit behavior.
- Do not use worktrees; work only on `codex/offline-auth-dialog`.
- Use targeted tests during tasks; run the complete suite only once at final verification.

---

### Task 1: AuthDialog frosted overlay

**Files:**
- Modify: `components/ui/dialog.tsx`
- Modify: `components/auth/auth-dialog.tsx`
- Test: `test/auth-dialog-overlay.test.tsx`

**Interfaces:**
- Produces: `DialogContentProps.overlayClassName?: string`, forwarded only to `DialogOverlay`.
- Consumes: `AuthDialog` renders `DialogContent` with its authentication-specific overlay class.

- [ ] **Step 1: Write the failing test**

```tsx
test("forwards an optional overlay class without changing the default overlay", () => {
  render(<DialogContent overlayClassName="backdrop-blur-sm" />);
  expect(screen.getByTestId("dialog-overlay")).toHaveClass("backdrop-blur-sm");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/auth-dialog-overlay.test.tsx`
Expected: FAIL because `overlayClassName` is not a DialogContent prop.

- [ ] **Step 3: Write minimal implementation**

```tsx
interface DialogContentProps extends DialogPrimitive.ContentProps {
  overlayClassName?: string;
  showCloseButton?: boolean;
}

<DialogOverlay className={overlayClassName} />
```

Pass `overlayClassName="backdrop-blur-sm"` from `AuthDialog` only.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/auth-dialog-overlay.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/ui/dialog.tsx components/auth/auth-dialog.tsx test/auth-dialog-overlay.test.tsx
git commit -m "feat: blur authentication dialog backdrop"
```

### Task 2: Edge packaging helper regression

**Files:**
- Modify: `scripts/zip-edge.mjs`
- Test: `test/zip-edge.test.ts`

**Interfaces:**
- Produces: Edge packaging launches the mocked or installed WXT command and copies the Chrome zip into its Edge-named artifact.

- [ ] **Step 1: Write the failing test**

Keep the existing mock `npx` fixture and add an assertion that the helper delegates through the command resolved from `PATH`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/zip-edge.test.ts`
Expected: FAIL because the helper invokes a package-runner path that the mock cannot execute.

- [ ] **Step 3: Write minimal implementation**

```js
const result = spawnSync("npx", ["wxt", "zip", "-b", "chrome", "--mv3"], {
  stdio: "inherit",
  env: process.env,
});
```

Use the portable invocation expected by the fixture while preserving failure propagation and artifact validation.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/zip-edge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/zip-edge.mjs test/zip-edge.test.ts
git commit -m "fix: restore Edge package helper"
```

### Task 3: Firefox manifest support floor regression

**Files:**
- Modify: `test/wxt-config.test.ts`
- Verify: `wxt.config.ts`

**Interfaces:**
- Produces: the manifest test asserts the configured Firefox support floor, currently `142.0`.

- [ ] **Step 1: Write the failing test**

The existing expectation for `128.0` is the RED case against the configured `142.0` floor.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/wxt-config.test.ts`
Expected: FAIL with expected `128.0`, received `142.0`.

- [ ] **Step 3: Write minimal implementation**

```ts
expect(manifest.browser_specific_settings?.gecko?.strict_min_version).toBe("142.0");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/wxt-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/wxt-config.test.ts
git commit -m "test: align Firefox manifest support floor"
```

### Task 4: Firefox storage session access-level regression

**Files:**
- Modify: `test/content.test.js`
- Verify: `lib/browser/storage-session.ts`, `entrypoints/background.ts`

**Interfaces:**
- Produces: Firefox test verifies no `browser.storage.session.setAccessLevel` call because that Chromium API is intentionally omitted from Firefox bundles.

- [ ] **Step 1: Write the failing test**

The existing assertion that Firefox calls `setAccessLevel("TRUSTED_CONTEXTS")` is the RED case against the documented unsupported API behavior.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/content.test.js`
Expected: FAIL because Firefox correctly does not call the Chromium-only API.

- [ ] **Step 3: Write minimal implementation**

```js
expect(browserSetAccessLevel).not.toHaveBeenCalled();
```

Rename the test to describe that Firefox skips the Chromium-only access-level API.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/content.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/content.test.js
git commit -m "test: align Firefox storage session expectation"
```

### Task 5: Final verification and handoff

**Files:**
- Verify: changed files from Tasks 1-4

- [ ] **Step 1: Run focused changed-area tests**

Run: `bun test test/auth-dialog-overlay.test.tsx test/zip-edge.test.ts test/wxt-config.test.ts test/content.test.js`
Expected: PASS.

- [ ] **Step 2: Run type check and production build**

Run: `bun run compile && bun run build`
Expected: PASS.

- [ ] **Step 3: Run complete automated suite once**

Run: `bun test`
Expected: PASS with no known failures remaining.

- [ ] **Step 4: Review and commit any verification documentation only if required**

Run: `git diff --check && git status --short`
Expected: no whitespace errors and a clean worktree.
