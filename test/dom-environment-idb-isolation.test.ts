// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, expect, test } from "bun:test";
import { installAppModules, setupDom, teardownDom } from "./helpers/dom-environment";
import { runsInIsolatedProcess } from "./helpers/isolated-run";
import { createModuleReplacer } from "./helpers/module-replacer";

// Start with an unopened canonical module regardless of other test files' order.
if (runsInIsolatedProcess(import.meta.filename)) {
  const replacer = createModuleReplacer();
  afterAll(async () => {
    replacer.restore();
    await teardownDom();
  });

  test("component setup leaves the restored canonical IndexedDB module able to open", async () => {
    const originalGetDB = (await import("@/lib/idb")).getDB;
    setupDom();
    await installAppModules(replacer);
    const componentGetDB = (await import("@/lib/idb")).getDB;
    // Persistence intentionally stays pending in the component-only module.
    void componentGetDB();
    replacer.restore();
    await teardownDom();
    const restoredGetDB = (await import("@/lib/idb")).getDB;
    expect(restoredGetDB).toBe(originalGetDB);

    // Only the browser open boundary is simulated; getDB and its cache stay real.
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: {
        open: () => {
          const request = {
            result: { name: "restored-canonical-db", onversionchange: null },
            onsuccess: () => {},
          };
          queueMicrotask(() => request.onsuccess());
          return request;
        },
      },
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        restoredGetDB().then((database) => database.name),
        new Promise<string>((resolve) => {
          timeout = setTimeout(() => resolve("canonical getDB stayed pending"), 250);
        }),
      ]);
      expect(result).toBe("restored-canonical-db");
      expect(componentGetDB).not.toBe(originalGetDB);
    } finally {
      clearTimeout(timeout);
    }
  });

  test("setupDom replaces a configurable nonwritable IndexedDB global", () => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      writable: false,
      value: {
        open: () => {
          throw new Error("Previous IndexedDB factory must not be used");
        },
      },
    });
    setupDom();
    expect(() => indexedDB.open("component-only")).not.toThrow();
  });
}
