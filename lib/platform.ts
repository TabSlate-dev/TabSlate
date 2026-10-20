/** macOS and iPadOS use Cmd where Windows and Linux use Ctrl. */
export function isMacPlatform(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(globalThis.navigator?.platform ?? "");
}

/** Cmd+click on macOS and Ctrl+click elsewhere toggle one item of a multi-selection. */
export function isToggleSelectionClick(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMacPlatform() ? event.metaKey : event.ctrlKey;
}
