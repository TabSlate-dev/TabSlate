// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";

import { SearchOverlaySessionStore, getSearchOverlaySession } from "../lib/search-overlay-session";

describe("SearchOverlaySessionStore", () => {
  const nonce = "a49f0fa8-2f92-467f-bda2-c1a2e5906d25";

  test("accepts a registered nonce only for its issuing tab", () => {
    const sessions = new SearchOverlaySessionStore(1_000);

    expect(sessions.register(nonce, 10, 100)).toBe(true);
    expect(sessions.validate(nonce, 11, 101)).toBe(false);
    expect(sessions.validate(nonce, 10, 102)).toBe(true);
  });

  test("expires a session that is never validated", () => {
    const sessions = new SearchOverlaySessionStore(1_000);

    sessions.register(nonce, 10, 100);

    expect(sessions.validate(nonce, 10, 1_100)).toBe(false);
  });

  test("renews the expiry on every successful validation", () => {
    const sessions = new SearchOverlaySessionStore(1_000);

    sessions.register(nonce, 10, 100);

    expect(sessions.validate(nonce, 10, 1_000)).toBe(true);
    expect(sessions.validate(nonce, 10, 1_900)).toBe(true);
    expect(sessions.validate(nonce, 10, 2_800)).toBe(true);
    expect(sessions.validate(nonce, 10, 3_800)).toBe(false);
  });

  test("does not renew the expiry for a validation from another tab", () => {
    const sessions = new SearchOverlaySessionStore(1_000);

    sessions.register(nonce, 10, 100);

    expect(sessions.validate(nonce, 11, 1_000)).toBe(false);
    expect(sessions.validate(nonce, 10, 1_100)).toBe(false);
  });

  test("revokes a session when its overlay closes", () => {
    const sessions = new SearchOverlaySessionStore(1_000);

    sessions.register(nonce, 10, 100);
    sessions.revoke(nonce, 10);

    expect(sessions.validate(nonce, 10, 101)).toBe(false);
  });
});

describe("getSearchOverlaySession", () => {
  test("returns a valid nonce and rejects missing or malformed parameters", () => {
    expect(getSearchOverlaySession("?session=a49f0fa8-2f92-467f-bda2-c1a2e5906d25")).toBe(
      "a49f0fa8-2f92-467f-bda2-c1a2e5906d25",
    );
    expect(getSearchOverlaySession("")).toBeNull();
    expect(getSearchOverlaySession("?session=not-a-nonce")).toBeNull();
  });
});
