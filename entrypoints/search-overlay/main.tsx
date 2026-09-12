import ReactDOM from "react-dom/client";
import { ThemeProvider } from "@/components/theme-provider";
import { SearchOverlay } from "@/components/search/search-overlay";
import { SEARCH_OVERLAY_CLOSE_MESSAGE } from "@/lib/messages";
import "@/assets/globals.css";

// This page is embedded as a full-viewport iframe inside a content script's
// closed ShadowRoot on arbitrary host pages (see entrypoints/content.ts). It
// must stay transparent so the SearchOverlay's own translucent backdrop is
// what the user sees, not an opaque page background.
document.documentElement.style.background = "transparent";
document.body.style.background = "transparent";
document.body.style.margin = "0";

function handleClose() {
  window.parent.postMessage({ type: SEARCH_OVERLAY_CLOSE_MESSAGE }, "*");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <SearchOverlay onClose={handleClose} />
  </ThemeProvider>,
);
