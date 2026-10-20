/** The window event that opens the bookmark dialog mounted by WorkspaceRail. */
export const OPEN_BOOKMARK_DIALOG_EVENT = "tabslate-open-bookmark";

export type BookmarkFormFocus = "tags" | "notes";

export interface OpenBookmarkDialogRequest {
  /** The bookmark to edit; omitted to add one. */
  bookmarkId?: string;
  /** The field that gets the cursor; the title by default. */
  focus?: BookmarkFormFocus;
}

/** Opens the bookmark dialog: add mode without an ID, edit mode with one. */
export function openBookmarkDialog(request: OpenBookmarkDialogRequest = {}): void {
  window.dispatchEvent(new CustomEvent<OpenBookmarkDialogRequest>(OPEN_BOOKMARK_DIALOG_EVENT, { detail: request }));
}

function isBookmarkFormFocus(value: unknown): value is BookmarkFormFocus {
  return value === "tags" || value === "notes";
}

/** Reads a request from the event, ignoring anything malformed. */
export function readOpenBookmarkDialogRequest(event: Event): OpenBookmarkDialogRequest {
  if (!(event instanceof CustomEvent)) {
    return {};
  }
  const detail: unknown = event.detail;
  if (typeof detail !== "object" || detail === null) {
    return {};
  }
  const bookmarkId: unknown = Reflect.get(detail, "bookmarkId");
  const focus: unknown = Reflect.get(detail, "focus");
  return {
    bookmarkId: typeof bookmarkId === "string" ? bookmarkId : undefined,
    focus: isBookmarkFormFocus(focus) ? focus : undefined,
  };
}
