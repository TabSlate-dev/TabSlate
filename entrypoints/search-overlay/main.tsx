import ReactDOM from "react-dom/client";
import { ThemeProvider } from "@/components/theme-provider";
import { SearchOverlay } from "@/components/search/search-overlay";
import { SEARCH_OVERLAY_CLOSE_MESSAGE } from "@/lib/messages";
import { getSearchOverlaySession } from "@/lib/search-overlay-session";
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

async function renderOverlay() {
  const session = getSearchOverlaySession(location.search);
  const root = document.getElementById("root");
  if (!session || !root) {
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: "VALIDATE_SEARCH_OVERLAY_SESSION",
      session,
    });
    if (response?.ok !== true) {
      return;
    }
  } catch {
    return;
  }

  ReactDOM.createRoot(root).render(
    <ThemeProvider>
      <SearchOverlay onClose={handleClose} session={session} />
    </ThemeProvider>,
  );
}

void renderOverlay();
