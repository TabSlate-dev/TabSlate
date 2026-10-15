// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";

const FIXTURE = "@/test/fixtures/replaceable-module";

describe("createModuleReplacer", () => {
  test("restores the exports registered before the replacement", async () => {
    const replacer = createModuleReplacer();
    await replacer.replace(FIXTURE, { value: "replacement" });
    expect((await import(FIXTURE)).value).toBe("replacement");

    replacer.restore();

    expect((await import(FIXTURE)).value).toBe("original");
  });

  test("importFresh loads the real module while a replacement is registered", async () => {
    const replacer = createModuleReplacer();
    await replacer.replace(FIXTURE, { value: "replacement" });

    const fresh = await importFresh<typeof import("@/test/fixtures/replaceable-module")>(
      "test/fixtures/replaceable-module.ts",
    );

    expect(fresh.value).toBe("original");
    replacer.restore();
  });
});
