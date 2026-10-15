/** The keys bound to opening the popup, or "" when none are set. */
export function findSaveShortcut(commands: readonly chrome.commands.Command[]): string {
  return commands.find((command) => command.name === "_execute_action")?.shortcut ?? "";
}
