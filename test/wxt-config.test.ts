// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";

import config from "../wxt.config";
import pkg from "../package.json";

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

    expect(manifest.browser_specific_settings?.gecko?.id).toBe("support@cs.tabslate.com");
    expect(manifest.browser_specific_settings?.gecko?.strict_min_version).toBe("142.0");
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

  test("adds the API origin to host permissions during manifest generation", async () => {
    const originalApiUrl = process.env.VITE_API_URL;
    process.env.VITE_API_URL = "https://sync.tabslate.com";

    try {
      const manifest = await getManifest("firefox", 3);
      const hook = (config.hooks as Record<string, unknown> | undefined)?.["build:manifestGenerated"];
      if (typeof hook !== "function") {
        throw new Error("Expected manifestGenerated hook");
      }

      await hook({} as never, manifest);
      expect(manifest.host_permissions).toContain("https://sync.tabslate.com/*");
    } finally {
      process.env.VITE_API_URL = originalApiUrl;
    }
  });
});

describe("Firefox packaging scripts", () => {
  test("package scripts expose signing entrypoints", () => {
    expect(pkg.scripts["zip:edge"]).toBe("node scripts/zip-edge.mjs");
    expect(pkg.scripts["package:firefox:amo"]).toBe("bun run zip:firefox");
    expect(pkg.scripts["sign:firefox"]).toBe("node scripts/sign-firefox.mjs");
    expect(pkg.scripts["package:firefox:selfhost"]).toBe(
      "node scripts/sign-firefox.mjs --selfhost",
    );
  });
});
