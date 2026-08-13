# Auth Dialog Blur and Browser Regression Repairs Design

## Goal

Add a frosted-glass background behind the authentication dialog, then restore the three existing cross-browser test regressions without changing authentication behavior or browser support policy.

## Scope

- Only `AuthDialog` receives a blurred overlay. Other dialogs retain the shared default overlay.
- The existing dimming overlay remains; the AuthDialog adds `backdrop-blur-sm` through a typed DialogContent overlay-class prop.
- OTP remains non-dismissible, credentials remain in one dialog, and captcha/rate-limit behavior is unchanged.
- Restore the Edge packaging helper test by using the package command available to the helper's mocked environment.
- Restore the Firefox manifest test by aligning its minimum Firefox version with the configured browser support floor.
- Restore the Firefox session-access test by asserting Firefox's supported behavior: no Chrome-only access-level call.

## Non-goals

- Do not change browser APIs, add dependencies, alter authentication state transitions, or broaden the visual treatment to all dialogs.
- Do not bypass Browser Use restrictions for Chrome internal or extension pages.

## Verification

- Add focused tests for the AuthDialog overlay prop and the three regression behaviors before implementation.
- Run each affected test file after its repair, then `bun run compile`, `bun run build`, and one final `bun test` run.
