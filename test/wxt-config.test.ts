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

const runManifestGeneratedHook = async (
  browser: "chrome" | "firefox",
  manifest: Awaited<ReturnType<typeof getManifest>>,
) => {
  const hook = (config.hooks as Record<string, unknown> | undefined)?.["build:manifestGenerated"];
  if (typeof hook !== "function") {
    throw new Error("Expected manifestGenerated hook");
  }

  await hook({ config: { browser } } as never, manifest);
};

const withEnv = async (key: string, value: string, run: () => Promise<void>) => {
  const original = process.env[key];
  process.env[key] = value;
  try {
    await run();
  } finally {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
};

describe("wxt cross-browser manifest", () => {
  test("suggests a shortcut that opens the save popup", async () => {
    const chromium = await getManifest("chrome", 3);
    const firefox = await getManifest("firefox", 3);

    expect(chromium.commands?._execute_action?.suggested_key).toEqual({
      default: "Ctrl+Shift+S",
      mac: "Command+Shift+S",
    });
    // Firefox reserves Ctrl+Shift+S for its screenshot tool.
    expect(firefox.commands?._execute_action?.suggested_key).toEqual({ default: "Alt+Shift+S" });
  });

  test("adds Firefox gecko metadata for MV3", async () => {
    const manifest = await getManifest("firefox", 3);

    expect(manifest.browser_specific_settings?.gecko?.id).toBe("support@cs.tabslate.com");
    expect(manifest.browser_specific_settings?.gecko?.strict_min_version).toBe("142.0");
    expect(manifest.browser_specific_settings?.gecko?.data_collection_permissions).toEqual({
      // Favicon lookups send bookmark domains to third-party icon services for every user.
      required: ["browsingActivity"],
      // Only sent once the user signs in and grants consent (lib/browser/data-collection.ts).
      optional: [
        "authenticationInfo",
        "personallyIdentifyingInfo",
        "searchTerms",
        "websiteContent",
        // Only sent once the user turns on view-preference sync (lib/browser/data-collection.ts).
        "technicalAndInteraction",
      ],
    });
  });

  test("keeps search and tabGroups permissions for Chromium builds", async () => {
    const manifest = await getManifest("chrome", 3);

    expect(manifest.permissions).toContain("search");
    expect(manifest.permissions).toContain("tabGroups");
    expect(manifest.chrome_url_overrides?.newtab).toBe("newtab.html");
  });

  test("grants activeTab to the Chromium and Firefox builds", async () => {
    for (const browser of ["chrome", "firefox"] as const) {
      const manifest = await getManifest(browser, 3);
      expect(manifest.permissions).toContain("activeTab");
    }
  });

  test("adds the API origin to host permissions during manifest generation", async () => {
    await withEnv("VITE_API_URL", "https://sync.tabslate.com", async () => {
      const manifest = await getManifest("firefox", 3);
      await runManifestGeneratedHook("firefox", manifest);
      expect(manifest.host_permissions).toContain("https://sync.tabslate.com/*");
    });
  });

  test("grants the analytics origin to Chromium builds only", async () => {
    await withEnv("VITE_OPENPANEL_URL", "https://analytics.example.test", async () => {
      const chromeManifest = await getManifest("chrome", 3);
      await runManifestGeneratedHook("chrome", chromeManifest);
      expect(chromeManifest.host_permissions).toContain("https://analytics.example.test/*");

      // Firefox builds never send analytics, so they must not ask for its origin.
      const firefoxManifest = await getManifest("firefox", 3);
      await runManifestGeneratedHook("firefox", firefoxManifest);
      expect(firefoxManifest.host_permissions ?? []).not.toContain(
        "https://analytics.example.test/*",
      );
    });
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
