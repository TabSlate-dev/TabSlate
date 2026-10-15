export type SaveBadgeKind = "saved" | "duplicate";

const BADGE_DURATION_MS = 3000;
const SAVED_COLOR = "#16a34a";
const DUPLICATE_COLOR = "#d97706";

interface BadgeFlash {
  timer?: ReturnType<typeof setTimeout>;
  defaultTitle?: string;
}

const activeFlashes = new Map<number, BadgeFlash>();

/**
 * Briefly marks the toolbar icon of one tab after a context-menu save. Badges
 * fit about four characters, so a duplicate shows a short word plus a full
 * tooltip. Best effort: failures are ignored.
 */
export async function flashSaveBadge(
  tabId: number,
  kind: SaveBadgeKind,
  durationMs = BADGE_DURATION_MS,
): Promise<void> {
  const previous = activeFlashes.get(tabId);
  if (previous?.timer !== undefined) {
    clearTimeout(previous.timer);
  }
  const flash: BadgeFlash = { defaultTitle: previous?.defaultTitle };
  activeFlashes.set(tabId, flash);
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: kind === "saved" ? SAVED_COLOR : DUPLICATE_COLOR });
    if (activeFlashes.get(tabId) !== flash) {
      return;
    }
    await chrome.action.setBadgeText({
      tabId,
      text: kind === "saved" ? "✓" : chrome.i18n.getMessage("badge_alreadySavedShort"),
    });
    if (activeFlashes.get(tabId) !== flash) {
      return;
    }
    if (kind === "duplicate") {
      flash.defaultTitle = await chrome.action.getTitle({});
      if (activeFlashes.get(tabId) !== flash) {
        return;
      }
      await chrome.action.setTitle({ tabId, title: chrome.i18n.getMessage("badge_alreadySavedTitle") });
    } else if (flash.defaultTitle !== undefined) {
      await chrome.action.setTitle({ tabId, title: flash.defaultTitle });
      flash.defaultTitle = undefined;
    }
  } catch {
    if (activeFlashes.get(tabId) === flash) {
      activeFlashes.delete(tabId);
    }
    return;
  }

  if (activeFlashes.get(tabId) !== flash) {
    return;
  }

  flash.timer = setTimeout(() => {
    if (activeFlashes.get(tabId) !== flash) {
      return;
    }
    activeFlashes.delete(tabId);
    void chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
    if (flash.defaultTitle !== undefined) {
      void chrome.action.setTitle({ tabId, title: flash.defaultTitle }).catch(() => {});
    }
  }, durationMs);
}
