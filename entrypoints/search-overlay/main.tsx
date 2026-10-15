import ReactDOM from "react-dom/client";
import { ThemeProvider } from "@/components/theme-provider";
import { SearchOverlay } from "@/components/search/search-overlay";
import { SEARCH_OVERLAY_CLOSE_MESSAGE } from "@/lib/messages";
import { SEARCH_OVERLAY_HEARTBEAT_MS, getSearchOverlaySession } from "@/lib/search-overlay-session";
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

async function isSessionValid(session: string): Promise<boolean> {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "VALIDATE_SEARCH_OVERLAY_SESSION",
      session,
    });
    return response?.ok === true;
  } catch {
    return false;
  }
}

async function renderOverlay() {
  const session = getSearchOverlaySession(location.search);
  const root = document.getElementById("root");
  // Nothing renders without a valid session, so ask the content script to
  // remove this transparent full-viewport iframe rather than leave it over
  // the page, swallowing clicks.
  if (!session || !root || !(await isSessionValid(session))) {
    handleClose();
    return;
  }

  // Keep the session alive while the overlay is open (see
  // SEARCH_OVERLAY_HEARTBEAT_MS), and close once it is gone, for example
  // revoked or lost with a restarted service worker.
  const heartbeat = setInterval(() => {
    void isSessionValid(session).then((valid) => {
      if (valid) {
        return;
      }
      clearInterval(heartbeat);
      handleClose();
    });
  }, SEARCH_OVERLAY_HEARTBEAT_MS);

  ReactDOM.createRoot(root).render(
    <ThemeProvider>
      <SearchOverlay onClose={handleClose} session={session} />
    </ThemeProvider>,
  );
}

void renderOverlay();
