// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import { importFresh } from "./helpers/module-replacer";

const { findSaveShortcut } = await importFresh<typeof import("@/lib/browser/commands")>("lib/browser/commands.ts");

describe("findSaveShortcut", () => {
  test("returns the keys bound to the popup", () => {
    expect(findSaveShortcut([
      { name: "open-search", shortcut: "Ctrl+Shift+K" },
      { name: "_execute_action", shortcut: "Ctrl+Shift+S" },
    ])).toBe("Ctrl+Shift+S");
  });
  test("returns an empty string when the user removed the binding", () => {
    expect(findSaveShortcut([{ name: "_execute_action", shortcut: "" }])).toBe("");
  });
  test("returns an empty string when the command is missing", () => {
    expect(findSaveShortcut([])).toBe("");
  });
});
