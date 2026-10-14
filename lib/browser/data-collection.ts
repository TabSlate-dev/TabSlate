import { isFirefoxBuild } from "@/lib/browser/env";
import { FIREFOX_ACCOUNT_DATA_COLLECTION } from "@/lib/browser/data-collection-permissions";

function accountDataCollection(): chrome.permissions.Permissions {
  return { data_collection: [...FIREFOX_ACCOUNT_DATA_COLLECTION] };
}

/**
 * Whether the user allows the data that signing in and syncing send to the
 * sync server. Only Firefox has built-in data consent; other builds always
 * return true. Fails closed if Firefox can't answer.
 */
export async function hasAccountDataConsent(): Promise<boolean> {
  if (!isFirefoxBuild()) {
    return true;
  }

  try {
    return await chrome.permissions.contains(accountDataCollection());
  } catch {
    return false;
  }
}

/**
 * Shows Firefox's data collection prompt, or resolves true right away when
 * consent was already given. Firefox only accepts this while handling user
 * input, so call it synchronously from the event handler, before any await.
 */
export function requestAccountDataConsent(): Promise<boolean> {
  if (!isFirefoxBuild()) {
    return Promise.resolve(true);
  }

  return chrome.permissions.request(accountDataCollection());
}

/** Calls `listener` whenever permissions change, e.g. consent toggled in about:addons. */
export function subscribeToPermissionChanges(listener: () => void): () => void {
  if (!isFirefoxBuild()) {
    return () => {};
  }

  chrome.permissions.onAdded.addListener(listener);
  chrome.permissions.onRemoved.addListener(listener);
  return () => {
    chrome.permissions.onAdded.removeListener(listener);
    chrome.permissions.onRemoved.removeListener(listener);
  };
}
