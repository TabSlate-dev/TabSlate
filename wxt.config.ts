import { defineConfig } from "wxt";

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
    version: "0.1.5",
    default_locale: "en",
    permissions: getPermissions(),
    optional_host_permissions: ["<all_urls>"],
    host_permissions: [],
    chrome_url_overrides: {
      newtab: "newtab.html",
    },
    web_accessible_resources: [
      { resources: ["newtab.html"], matches: getNewtabMatches(browser) },
    ],
    commands: {
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
              id: "@tabslate",
              strict_min_version: "128.0",
              data_collection_permissions: {
                required: ["none"],
              },
            },
          },
        }
      : {}),
  }),
  vite: () => ({
    build: {
      sourcemap: process.env.NODE_ENV !== "production",
    },
  }),
  hooks: {
    "build:manifestGenerated": (_wxt, manifest) => {
      // Remove auto-generated host_permissions that conflict with optional_host_permissions
      delete manifest.host_permissions;

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
      if (openpanelUrl) {
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
