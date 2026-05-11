import React from "react";
import ReactDOM from "react-dom/client";
import { SearchOverlay } from "@/components/search/search-overlay";
import "@/assets/globals.css";

export default defineContentScript({
  matches: ["<all_urls>"],
  cssInjectionMode: "ui",
  registration: "runtime",

  async main(ctx) {
    // -----------------------------------------------------------------
    // Search overlay — Shadow Root for CSS isolation, isolateEvents so
    // keyboard input doesn't leak to the host page
    // -----------------------------------------------------------------
    let currentUi: { remove: () => void; shadow: ShadowRoot } | null = null;

    async function showOverlay() {
      if (currentUi) { return; }

      const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

      const ui = await createShadowRootUi(ctx, {
        name: "tabslate-search-overlay",
        position: "overlay",
        zIndex: 2147483647,
        // Prevent keydown/keyup/keypress from bubbling to the host page
        isolateEvents: true,
        onMount(uiContainer) {
          // Add dark class so Tailwind dark: variants work inside shadow root
          if (isDark) { uiContainer.classList.add("dark"); }

          const root = ReactDOM.createRoot(uiContainer);
          root.render(React.createElement(SearchOverlay, { onClose: hideOverlay }));
          return root;
        },
        onRemove(root) {
          root?.unmount();
          currentUi = null;
        },
      });

      ui.mount();
      currentUi = ui;

      // React renders asynchronously inside shadow root; wait for paint + render
      setTimeout(() => {
        ui.shadow.querySelector<HTMLInputElement>("input")?.focus();
      }, 150);
    }

    function hideOverlay() {
      currentUi?.remove();
    }

    // -----------------------------------------------------------------
    // Message listener
    // -----------------------------------------------------------------
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === "OPEN_SEARCH") {
        showOverlay();
        return false;
      }

      if (message.type !== "GET_PAGE_INFO") { return false; }

      const faviconEl =
        document.querySelector<HTMLLinkElement>('link[rel="icon"]') ??
        document.querySelector<HTMLLinkElement>('link[rel="shortcut icon"]');
      const favicon = faviconEl?.href ?? `${location.origin}/favicon.ico`;

      const ogTitle =
        document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content ?? "";

      const metaDescription =
        document.querySelector<HTMLMetaElement>('meta[property="og:description"]')?.content ??
        document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ??
        "";

      sendResponse({
        title: document.title,
        url: location.href,
        selectedText: window.getSelection()?.toString()?.trim() ?? "",
        favicon,
        ogTitle,
        metaDescription,
      });

      return true;
    });
  },
});
