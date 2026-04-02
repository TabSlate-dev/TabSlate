export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type !== "GET_PAGE_INFO") { return false; }

      const faviconEl =
        document.querySelector<HTMLLinkElement>('link[rel="icon"]') ??
        document.querySelector<HTMLLinkElement>('link[rel="shortcut icon"]');
      const favicon = faviconEl?.href ?? `${location.origin}/favicon.ico`;

      sendResponse({
        title: document.title,
        url: location.href,
        selectedText: window.getSelection()?.toString()?.trim() ?? "",
        favicon,
      });

      return true;
    });
  },
});
