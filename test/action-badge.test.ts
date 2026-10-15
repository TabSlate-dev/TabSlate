// @ts-expect-error Bun provides this test module at runtime.
import { afterEach, describe, expect, test } from "bun:test";
import { importFresh } from "./helpers/module-replacer";

const originalChrome = Reflect.get(globalThis, "chrome");
const messages: Record<string, string> = {
  badge_alreadySavedShort: "Dup",
  badge_alreadySavedTitle: "Already saved in TabSlate",
};

function stubChrome(failBadge = false) {
  const calls: Array<[string, object]> = [];
  Reflect.set(globalThis, "chrome", {
    i18n: { getMessage: (key: string) => messages[key] ?? "" },
    action: {
      getTitle: async () => "TabSlate",
      setTitle: async (details: object) => {
        calls.push(["setTitle", details]);
      },
      setBadgeText: async (details: object) => {
        if (failBadge) {
          throw new Error("no action");
        }
        calls.push(["setBadgeText", details]);
      },
      setBadgeBackgroundColor: async (details: object) => {
        calls.push(["setBadgeBackgroundColor", details]);
      },
    },
  });
  return calls;
}

afterEach(() => {
  Reflect.set(globalThis, "chrome", originalChrome);
});

// Short badge durations keep the clearing timer inside each test, while the chrome stub is installed.
const outlast = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("flashSaveBadge", () => {
  test("marks a skipped duplicate in amber with an explanatory tooltip, then restores the action", async () => {
    const calls = stubChrome();
    const { flashSaveBadge } = await importFresh<typeof import("@/lib/browser/action-badge")>("lib/browser/action-badge.ts");

    await flashSaveBadge(7, "duplicate", 5);

    expect(calls).toEqual([
      ["setBadgeBackgroundColor", { tabId: 7, color: "#d97706" }],
      ["setBadgeText", { tabId: 7, text: "Dup" }],
      ["setTitle", { tabId: 7, title: "Already saved in TabSlate" }],
    ]);

    await outlast(30);

    expect(calls.slice(3)).toEqual([
      ["setBadgeText", { tabId: 7, text: "" }],
      ["setTitle", { tabId: 7, title: "TabSlate" }],
    ]);
  });

  test("marks a successful save with a green check, then clears it", async () => {
    const calls = stubChrome();
    const { flashSaveBadge } = await importFresh<typeof import("@/lib/browser/action-badge")>("lib/browser/action-badge.ts");

    await flashSaveBadge(7, "saved", 5);

    expect(calls).toEqual([
      ["setBadgeBackgroundColor", { tabId: 7, color: "#16a34a" }],
      ["setBadgeText", { tabId: 7, text: "✓" }],
    ]);

    await outlast(30);

    expect(calls.slice(2)).toEqual([["setBadgeText", { tabId: 7, text: "" }]]);
  });

  test("stops quietly when the action API fails, without scheduling a reset", async () => {
    const calls = stubChrome(true);
    const { flashSaveBadge } = await importFresh<typeof import("@/lib/browser/action-badge")>("lib/browser/action-badge.ts");

    await expect(flashSaveBadge(7, "saved", 5)).resolves.toBeUndefined();
    await outlast(30);

    expect(calls).toEqual([["setBadgeBackgroundColor", { tabId: 7, color: "#16a34a" }]]);
  });

  test("a newer duplicate keeps its badge until its own timer expires", async () => {
    const calls = stubChrome();
    const { flashSaveBadge } = await importFresh<typeof import("@/lib/browser/action-badge")>("lib/browser/action-badge.ts");

    await flashSaveBadge(7, "saved", 15);
    await flashSaveBadge(7, "duplicate", 80);
    try {
      await outlast(35);
      expect(calls).not.toContainEqual(["setBadgeText", { tabId: 7, text: "" }]);
    } finally {
      await outlast(90);
    }
    expect(calls.slice(-2)).toEqual([
      ["setBadgeText", { tabId: 7, text: "" }],
      ["setTitle", { tabId: 7, title: "TabSlate" }],
    ]);
  });

  test("a newer saved badge restores the duplicate tooltip and replaces its reset", async () => {
    const calls = stubChrome();
    const { flashSaveBadge } = await importFresh<typeof import("@/lib/browser/action-badge")>("lib/browser/action-badge.ts");

    await flashSaveBadge(7, "duplicate", 15);
    await flashSaveBadge(7, "saved", 80);
    try {
      expect(calls).toContainEqual(["setTitle", { tabId: 7, title: "TabSlate" }]);
      await outlast(35);
      expect(calls).not.toContainEqual(["setBadgeText", { tabId: 7, text: "" }]);
    } finally {
      await outlast(90);
    }
    expect(calls.slice(-1)).toEqual([["setBadgeText", { tabId: 7, text: "" }]]);
  });

});
