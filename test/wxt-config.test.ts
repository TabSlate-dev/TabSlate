// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";

import config from "../wxt.config";

const getManifest = async (
  browser: "chrome" | "firefox" | "edge",
  manifestVersion: 3,
) => {
  const manifestFactory = config.manifest;
  if (typeof manifestFactory !== "function") {
    throw new Error("Expected function manifest config");
  }

  return await manifestFactory({
    browser,
    manifestVersion,
    mode: "production",
    command: "build",
  });
};

describe("wxt cross-browser manifest", () => {
  test("adds Firefox gecko metadata for MV3", async () => {
    const manifest = await getManifest("firefox", 3);

    expect(manifest.browser_specific_settings?.gecko?.id).toBe("@tabslate");
    expect(manifest.browser_specific_settings?.gecko?.strict_min_version).toBe("128.0");
    expect(
      manifest.browser_specific_settings?.gecko?.data_collection_permissions?.required,
    ).toEqual(["none"]);
  });

  test("keeps search and tabGroups permissions for Chromium builds", async () => {
    const manifest = await getManifest("chrome", 3);

    expect(manifest.permissions).toContain("search");
    expect(manifest.permissions).toContain("tabGroups");
    expect(manifest.chrome_url_overrides?.newtab).toBe("newtab.html");
  });
});
