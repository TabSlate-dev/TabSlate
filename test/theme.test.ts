// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";

import * as themeModule from "../lib/theme";

describe("resolveTheme", () => {
  test("uses the selected light or dark theme directly", () => {
    expect(themeModule.resolveTheme("light", true)).toBe("light");
    expect(themeModule.resolveTheme("dark", false)).toBe("dark");
  });

  test("resolves system theme from the color-scheme preference", () => {
    expect(themeModule.resolveTheme("system", true)).toBe("dark");
    expect(themeModule.resolveTheme("system", false)).toBe("light");
  });
});
