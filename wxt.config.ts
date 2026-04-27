import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "TabSlate (标签石板)",
    description: "一个简洁高效的标签页与书签管理工具 / A clean and efficient tab and bookmark manager",
    version: "0.1.0",
    permissions: ["tabs", "tabGroups", "storage", "bookmarks", "sessions", "contextMenus", "favicon"],
    host_permissions: ["<all_urls>"],
    chrome_url_overrides: {
      newtab: "newtab.html",
    },
  },
  vite: () => ({
    build: {
      sourcemap: true,
    },
  }),
});

