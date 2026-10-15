// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";

const FIXTURE = "@/test/fixtures/replaceable-module";

describe("createModuleReplacer", () => {
  test("restores the exports registered before the replacement", async () => {
    const replacer = createModuleReplacer();
    await replacer.replace(FIXTURE, { value: "replacement" });
    try {
      expect((await import(FIXTURE)).value).toBe("replacement");
    } finally {
      replacer.restore();
    }

    expect((await import(FIXTURE)).value).toBe("original");
  });

  test("importFresh loads the real module while a replacement is registered", async () => {
    const replacer = createModuleReplacer();
    await replacer.replace(FIXTURE, { value: "replacement" });

    try {
      const fresh = await importFresh<typeof import("@/test/fixtures/replaceable-module")>(
        "test/fixtures/replaceable-module.ts",
      );

      expect(fresh.value).toBe("original");
    } finally {
      replacer.restore();
    }
  });

  test("restores stacked replacements in reverse order even after an assertion throws", async () => {
    const replacer = createModuleReplacer();
    try {
      await replacer.replace(FIXTURE, { value: "first" });
      await replacer.replace(FIXTURE, { value: "second" });
      expect((await import(FIXTURE)).value).toBe("second");
      expect(() => {
        try {
          expect("intentional failure").toBe("different");
        } finally {
          replacer.restore();
        }
      }).toThrow();
      expect((await import(FIXTURE)).value).toBe("original");
    } finally {
      replacer.restore();
    }
  });
});
