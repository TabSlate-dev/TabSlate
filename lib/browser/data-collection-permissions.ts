// Firefox built-in data collection consent (Firefox 140+ desktop, 142+ Android):
// https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/
//
// Shared by the manifest declaration in wxt.config.ts and the runtime consent
// requests in lib/browser/data-collection.ts — Firefox rejects
// permissions.request() for any category missing from
// data_collection_permissions.optional, so the two must not drift apart.
// Kept free of imports so wxt.config.ts can load it at build time.

export type FirefoxDataCollectionPermission =
  | "authenticationInfo"
  | "bookmarksInfo"
  | "browsingActivity"
  | "financialAndPaymentInfo"
  | "healthInfo"
  | "locationInfo"
  | "personalCommunications"
  | "personallyIdentifyingInfo"
  | "searchTerms"
  | "technicalAndInteraction"
  | "websiteActivity"
  | "websiteContent";

/**
 * Sent for every user, signed in or not: bookmark and search-result favicons
 * are loaded from icons.duckduckgo.com / www.google.com/s2/favicons with the
 * bookmark's domain in the URL. Synced bookmark and tab URLs fall under this
 * category as well.
 */
export const FIREFOX_REQUIRED_DATA_COLLECTION: readonly FirefoxDataCollectionPermission[] = [
  "browsingActivity",
];

/**
 * Sent to the sync server only after the user signs in and grants this
 * consent: account email, name and password (personallyIdentifyingInfo,
 * authenticationInfo), bookmark titles and descriptions taken from page
 * content (websiteContent), and server-side bookmark search queries
 * (searchTerms).
 */
export const FIREFOX_ACCOUNT_DATA_COLLECTION: readonly FirefoxDataCollectionPermission[] = [
  "authenticationInfo",
  "personallyIdentifyingInfo",
  "searchTerms",
  "websiteContent",
];
