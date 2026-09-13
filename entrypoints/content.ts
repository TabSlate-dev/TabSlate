import { SEARCH_OVERLAY_CLOSE_MESSAGE } from "@/lib/messages";

export default defineContentScript({
  matches: ["<all_urls>"],
  registration: "runtime",

  async main(ctx) {
    // -----------------------------------------------------------------
    // Search overlay — rendered in an extension-origin iframe (see
    // entrypoints/search-overlay), not directly in this content script's
    // world. The iframe is a separate browsing context from the host page:
    // the host page cannot read its DOM, dispatch synthetic input into it,
    // or observe keystrokes typed inside it. The outer ShadowRoot (closed,
    // so the host page can't even obtain a reference to the iframe element)
    // is only used to host and position that iframe.
    // -----------------------------------------------------------------
    let currentUi: { remove: () => void } | null = null;
    let currentIframe: HTMLIFrameElement | null = null;
    let openingOverlay = false;

    function handleOverlayMessage(event: MessageEvent) {
      if (event.source !== currentIframe?.contentWindow) { return; }
      if ((event.data as { type?: string } | null)?.type === SEARCH_OVERLAY_CLOSE_MESSAGE) {
        hideOverlay();
      }
    }

    async function showOverlay() {
      if (currentUi || openingOverlay) { return; }

      openingOverlay = true;
      const session = crypto.randomUUID();
      try {
        const response = await chrome.runtime.sendMessage({ type: "REGISTER_SEARCH_OVERLAY_SESSION", session });
        if (response?.ok !== true) {
          openingOverlay = false;
          return;
        }
      } catch {
        openingOverlay = false;
        return;
      }

      const ui = await createShadowRootUi(ctx, {
        name: "tabslate-search-overlay",
        position: "overlay",
        zIndex: 2147483647,
        mode: "closed",
        onMount(uiContainer) {
          const iframe = document.createElement("iframe");
          iframe.src = chrome.runtime.getURL(`search-overlay.html?session=${encodeURIComponent(session)}`);
          iframe.title = "TabSlate Search";
          iframe.style.cssText =
            "position:fixed;inset:0;width:100%;height:100%;border:none;background:transparent;";
          uiContainer.appendChild(iframe);
          currentIframe = iframe;
          window.addEventListener("message", handleOverlayMessage);
          return iframe;
        },
        onRemove() {
          window.removeEventListener("message", handleOverlayMessage);
          void chrome.runtime.sendMessage({ type: "REVOKE_SEARCH_OVERLAY_SESSION", session }).catch(() => {});
          currentIframe = null;
          currentUi = null;
        },
      });

      ui.mount();
      currentUi = ui;
      openingOverlay = false;
    }

    function hideOverlay() {
      currentUi?.remove();
    }

    // -----------------------------------------------------------------
    // Message listener
    // -----------------------------------------------------------------
    function handleMessage(
      message: { type?: string },
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ) {
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
    }

    chrome.runtime.onMessage.addListener(handleMessage);
    ctx.onInvalidated(() => chrome.runtime.onMessage.removeListener(handleMessage));
  },
});
