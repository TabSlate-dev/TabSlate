import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "__MSG_extensionName__",
    description: "__MSG_extensionDescription__",
    version: "0.1.1",
    default_locale: "en",
    permissions: ["tabs", "tabGroups", "storage", "contextMenus", "scripting", "search"],
    optional_host_permissions: ["<all_urls>"],
    host_permissions: [],
    chrome_url_overrides: {
      newtab: "newtab.html",
    },
    web_accessible_resources: [
      { resources: ["newtab.html"], matches: ["*://*.tabslate.com/*", "http://localhost:*/*"] },
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
  },
  vite: () => ({
    build: {
      sourcemap: process.env.NODE_ENV !== "production",
    },
  }),
  hooks: {
    "build:manifestGenerated": (wxt, manifest) => {
      // Remove auto-generated host_permissions that conflict with optional_host_permissions
      delete manifest.host_permissions;

      const openpanelUrl = process.env.VITE_OPENPANEL_URL;
      if (!openpanelUrl) {
        return;
      }

      try {
        manifest.host_permissions = [`${new URL(openpanelUrl).origin}/*`];
      } catch {
        // Ignore invalid local config so the build still succeeds without analytics.
      }
    },
  },
});
