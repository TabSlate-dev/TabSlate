import { defineConfig } from "wxt";
import {
  FIREFOX_ACCOUNT_DATA_COLLECTION,
  FIREFOX_REQUIRED_DATA_COLLECTION,
  FIREFOX_SETTINGS_DATA_COLLECTION,
} from "./lib/browser/data-collection-permissions";

function getPermissions(): string[] {
  return ["tabs", "tabGroups", "storage", "contextMenus", "scripting", "search"];
}

function getNewtabMatches(browser: string): string[] {
  if (browser === "firefox") {
    return ["*://*.tabslate.com/*", "http://localhost/*"];
  }

  return ["*://*.tabslate.com/*", "http://localhost:*/*"];
}

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: ({ browser }) => ({
    name: "__MSG_extensionName__",
    description: "__MSG_extensionDescription__",
    version: "0.2.2",
    default_locale: "en",
    permissions: getPermissions(),
    optional_host_permissions: ["<all_urls>"],
    host_permissions: [],
    chrome_url_overrides: {
      newtab: "newtab.html",
    },
    web_accessible_resources: [
      { resources: ["newtab.html"], matches: getNewtabMatches(browser) },
      // The global search overlay is embedded as an iframe by the content
      // script on whatever site the user has granted optional host access
      // to, so it must be loadable there — the content script itself is
      // only ever registered on granted origins (see background.ts).
      { resources: ["search-overlay.html"], matches: ["<all_urls>"] },
    ],
    commands: {
      _execute_action: {
        // Firefox reserves Ctrl+Shift+S for its screenshot tool.
        suggested_key: browser === "firefox"
          ? { default: "Alt+Shift+S" }
          : { default: "Ctrl+Shift+S", mac: "Command+Shift+S" },
      },
      "open-search": {
        suggested_key: {
          default: "Ctrl+Shift+K",
          mac: "Command+Shift+K",
        },
        description: "__MSG_commandOpenSearch__",
      },
    },
    ...(browser === "firefox"
      ? {
          browser_specific_settings: {
            gecko: {
              id: "support@cs.tabslate.com",
              strict_min_version: "142.0",
              // What leaves the browser is documented next to each list in
              // lib/browser/data-collection-permissions.ts. technicalAndInteraction
              // covers synced view preferences only; Firefox builds never send
              // analytics (lib/analytics.ts).
              data_collection_permissions: {
                required: [...FIREFOX_REQUIRED_DATA_COLLECTION],
                optional: [...FIREFOX_ACCOUNT_DATA_COLLECTION, ...FIREFOX_SETTINGS_DATA_COLLECTION],
              },
            },
          },
        }
      : {}),
  }),
  vite: () => ({
    build: {
      sourcemap: process.env.NODE_ENV !== "production",
      // Extension pages load from local disk with no network latency to
      // hide, so the modulepreload optimization has nothing to offer. Worse,
      // Chrome's extension-page world isolation means the preloaded request
      // never matches the actual dynamic import, so every emitted
      // <link rel="modulepreload"> just produces a console warning
      // ("cross-world extension resource mismatch") for no benefit.
      modulePreload: false,
    },
  }),
  hooks: {
    "build:manifestGenerated": (wxt, manifest) => {
      // Remove auto-generated host_permissions that conflict with optional_host_permissions
      delete manifest.host_permissions;

      if (manifest.content_scripts?.length === 0) {
        delete manifest.content_scripts;
      }

      const hostPermissionOrigins = new Set<string>();
      const apiUrl = process.env.VITE_API_URL;
      if (apiUrl) {
        try {
          hostPermissionOrigins.add(`${new URL(apiUrl).origin}/*`);
        } catch {
          // Ignore invalid local config so the build still succeeds.
        }
      }

      const openpanelUrl = process.env.VITE_OPENPANEL_URL;
      // Firefox builds never send analytics (see lib/analytics.ts).
      if (openpanelUrl && wxt.config.browser !== "firefox") {
        try {
          hostPermissionOrigins.add(`${new URL(openpanelUrl).origin}/*`);
        } catch {
          // Ignore invalid local config so the build still succeeds without analytics.
        }
      }

      if (hostPermissionOrigins.size > 0) {
        manifest.host_permissions = Array.from(hostPermissionOrigins);
      }
    },
  },
});
