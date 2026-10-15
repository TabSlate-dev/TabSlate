import { findVisibleDuplicates, type BookmarkLibrary } from "@/lib/duplicate-lookup";

export interface ContextMenuLibrary extends BookmarkLibrary {
  activeWorkspaceId: string;
}

export type ContextMenuSaveOutcome = "save" | "duplicate";

/**
 * Context-menu saves have no UI to ask, so the same address (strict tier) in
 * the active workspace is skipped. A failed lookup never blocks the save.
 */
export async function resolveContextMenuSave(
  url: string,
  loadLibrary: () => Promise<ContextMenuLibrary>,
): Promise<ContextMenuSaveOutcome> {
  try {
    const library = await loadLibrary();
    const duplicates = findVisibleDuplicates(url, library, "strict", { workspaceId: library.activeWorkspaceId });
    return duplicates.length > 0 ? "duplicate" : "save";
  } catch (err) {
    console.warn("[TabSlate] duplicate check failed; saving anyway:", err);
    return "save";
  }
}
