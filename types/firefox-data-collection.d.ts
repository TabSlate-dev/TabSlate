// Firefox adds built-in data collection consent to the permissions API
// (Firefox 140+), which @types/chrome does not describe:
// https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/permissions/Permissions
declare namespace chrome.permissions {
  interface Permissions {
    data_collection?: string[];
  }
}
