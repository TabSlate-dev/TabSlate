// @ts-expect-error Bun provides this test module at runtime.
import { beforeEach, describe, expect, test } from "bun:test";
import { importFresh } from "./helpers/module-replacer";

const { useSelectionStore, selectionStateOf } =
  await importFresh<typeof import("@/store/selection-store")>("store/selection-store.ts");
const { isMacPlatform, isToggleSelectionClick } =
  await importFresh<typeof import("@/lib/platform")>("lib/platform.ts");

const ORDER = ["a", "b", "c", "d", "e"];
const store = () => useSelectionStore.getState();
const selected = () => [...store().selectedIds].sort();

beforeEach(() => {
  store().clear();
});

describe("selection store", () => {
  test("toggle adds and removes one bookmark and makes it the anchor", () => {
    store().toggle("b");
    expect(selected()).toEqual(["b"]);
    expect(store().anchorId).toBe("b");
    store().toggle("b");
    expect(selected()).toEqual([]);
    expect(store().anchorId).toBe("b");
  });

  test("replaces the set on every change instead of mutating it", () => {
    const before = store().selectedIds;
    store().toggle("a");
    expect(before.has("a")).toBe(false);
    expect(store().selectedIds).not.toBe(before);
  });

  test("range, group and membership changes preserve earlier selection snapshots", () => {
    store().toggle("b");
    const initial = store().selectedIds;
    store().selectRange(ORDER, "d");
    const ranged = store().selectedIds;
    store().setMany(["e"], true);
    const grouped = store().selectedIds;
    store().retain(["b"]);
    expect([...initial]).toEqual(["b"]);
    expect([...ranged]).toEqual(["b", "c", "d"]);
    expect([...grouped]).toEqual(["b", "c", "d", "e"]);
    expect(selected()).toEqual(["b"]);
  });

  test("selectRange adds everything between the anchor and the target and keeps the anchor", () => {
    store().toggle("b");
    store().selectRange(ORDER, "d");
    expect(selected()).toEqual(["b", "c", "d"]);
    expect(store().anchorId).toBe("b");
    store().selectRange(ORDER, "a");
    expect(selected()).toEqual(["a", "b", "c", "d"]);
  });

  test("selectRange without a usable anchor toggles the target", () => {
    store().selectRange(ORDER, "c");
    expect(selected()).toEqual(["c"]);
    expect(store().anchorId).toBe("c");
    store().selectRange(["x", "y"], "y");
    expect(selected()).toEqual(["c", "y"]);
    expect(store().anchorId).toBe("y");
  });

  test("selectRange with a missing target toggles it instead of selecting an unrelated range", () => {
    store().toggle("b");
    store().selectRange(ORDER, "outside");
    expect(selected()).toEqual(["b", "outside"]);
    expect(store().anchorId).toBe("outside");
  });

  test("setMany selects or deselects a group without moving the anchor", () => {
    store().toggle("a");
    store().setMany(["c", "d"], true);
    expect(selected()).toEqual(["a", "c", "d"]);
    store().setMany(["a", "c"], false);
    expect(selected()).toEqual(["d"]);
    expect(store().anchorId).toBe("a");
  });

  test("retain drops bookmarks that left the view and leaves the state alone when none did", () => {
    store().setMany(["a", "b"], true);
    const before = store();
    store().retain(["a", "b", "c"]);
    expect(store()).toBe(before);

    store().toggle("b");
    store().toggle("b");
    store().retain(["a"]);
    expect(selected()).toEqual(["a"]);
    expect(store().anchorId).toBeNull();
  });

  test("clear empties the selection and leaves an empty one alone", () => {
    store().setMany(["a", "b"], true);
    store().clear();
    expect(selected()).toEqual([]);
    expect(store().anchorId).toBeNull();
    const before = store();
    store().clear();
    expect(store()).toBe(before);
  });

  test("selectionStateOf reports all, some or none of a group", () => {
    const ids = new Set(["a", "b"]);
    expect(selectionStateOf(ids, ["a", "b"])).toBe("all");
    expect(selectionStateOf(ids, ["a", "c"])).toBe("some");
    expect(selectionStateOf(ids, ["c"])).toBe("none");
    expect(selectionStateOf(ids, [])).toBe("none");
  });
});

describe("selection platform modifiers", () => {
  test("uses Cmd on Apple platforms and Ctrl on other platforms", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    try {
      for (const platform of ["MacIntel", "iPhone", "iPad", "iPod"]) {
        Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform } });
        expect(isMacPlatform()).toBe(true);
        expect(isToggleSelectionClick({ metaKey: true, ctrlKey: false })).toBe(true);
        expect(isToggleSelectionClick({ metaKey: false, ctrlKey: true })).toBe(false);
      }
      for (const platform of ["Win32", "Linux x86_64", ""]) {
        Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform } });
        expect(isMacPlatform()).toBe(false);
        expect(isToggleSelectionClick({ metaKey: false, ctrlKey: true })).toBe(true);
        expect(isToggleSelectionClick({ metaKey: true, ctrlKey: false })).toBe(false);
      }
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: undefined });
      expect(isMacPlatform()).toBe(false);
    } finally {
      if (original) {
        Object.defineProperty(globalThis, "navigator", original);
      } else {
        Reflect.deleteProperty(globalThis, "navigator");
      }
    }
  });
});
