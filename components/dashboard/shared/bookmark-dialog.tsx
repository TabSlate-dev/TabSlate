import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BookmarkForm } from "@/components/dashboard/shared/bookmark-form";
import { useTranslation } from "@/hooks/use-translation";
import {
  OPEN_BOOKMARK_DIALOG_EVENT,
  readOpenBookmarkDialogRequest,
  type BookmarkFormFocus,
} from "@/lib/bookmark-dialog-events";
import type { Bookmark } from "@/lib/types";
import { isActiveWorkspace } from "@/lib/workspace-visibility";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useWorkspaceStore } from "@/store/workspace-store";

interface DialogRequest {
  /** Remounts the form for every request, so it always starts from that request. */
  key: number;
  bookmark?: Bookmark;
  focus?: BookmarkFormFocus;
}

/**
 * The one add/edit bookmark dialog. WorkspaceRail mounts it once, and anything
 * opens it with openBookmarkDialog(). An edit request for a bookmark that is
 * no longer active is ignored.
 */
export function BookmarkDialog() {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [request, setRequest] = React.useState<DialogRequest | null>(null);
  const nextKey = React.useRef(0);

  React.useEffect(() => {
    const handleOpenRequest = (event: Event) => {
      const { bookmarkId, focus } = readOpenBookmarkDialogRequest(event);
      const bookmark = bookmarkId === undefined ? undefined : useBookmarksStore.getState().bookmarks.get(bookmarkId);
      if (bookmarkId !== undefined && !bookmark) {
        return;
      }
      if (bookmark && bookmark.collectionId !== "") {
        const state = useWorkspaceStore.getState();
        const parent = state.collections.find((collection) => collection.id === bookmark.collectionId);
        const workspace = state.workspaces.find((candidate) => candidate.id === parent?.workspaceId);
        if (!parent || parent.deletedAt || parent.archivedAt || !isActiveWorkspace(workspace)) {
          return;
        }
      }
      nextKey.current += 1;
      setRequest({ key: nextKey.current, bookmark, focus });
      setOpen(true);
    };
    window.addEventListener(OPEN_BOOKMARK_DIALOG_EVENT, handleOpenRequest);
    return () => window.removeEventListener(OPEN_BOOKMARK_DIALOG_EVENT, handleOpenRequest);
  }, []);

  const handleOpenAutoFocus = React.useCallback((event: Event) => {
    if (!request?.focus || !(event.currentTarget instanceof HTMLElement)) {
      return;
    }
    const selector = request.focus === "tags" ? '[role="combobox"]' : 'textarea[name="notes"]';
    const field = event.currentTarget.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
    if (!field) {
      return;
    }
    // React autoFocus runs while an opening menu may still trap focus. Radix
    // invokes this after activating the dialog's own focus scope.
    event.preventDefault();
    field.focus();
    if (request.focus === "notes") {
      field.setSelectionRange(field.value.length, field.value.length);
    }
  }, [request?.focus]);
  const handleClose = React.useCallback(() => setOpen(false), []);
  const editing = request?.bookmark !== undefined;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-lg" onOpenAutoFocus={handleOpenAutoFocus}>
        <DialogHeader>
          <DialogTitle>{t(editing ? "bookmarkForm_editTitle" : "bookmarkForm_addTitle")}</DialogTitle>
          <DialogDescription>{t(editing ? "bookmarkForm_editDesc" : "bookmarkForm_addDesc")}</DialogDescription>
        </DialogHeader>
        {request && (
          <BookmarkForm
            key={request.key}
            bookmark={request.bookmark}
            focus={request.focus}
            onDone={handleClose}
            onCancel={handleClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
