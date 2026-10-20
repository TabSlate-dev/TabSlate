import * as React from "react";
import { StickyNote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useTranslation } from "@/hooks/use-translation";
import { openBookmarkDialog } from "@/lib/bookmark-dialog-events";
import { linkifySegments } from "@/lib/linkify";

interface BookmarkNotesPopoverProps {
  bookmarkId: string;
  notes: string;
}

/**
 * A card's notes button and the popover with the whole note. Clicks inside
 * stop at the popover, so they neither open the bookmark nor change the
 * selection; right-clicks keep the browser's menu for links.
 */
export function BookmarkNotesPopover({ bookmarkId, notes }: BookmarkNotesPopoverProps) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const editingRef = React.useRef(false);
  const segments = React.useMemo(() => linkifySegments(notes), [notes]);

  const handleStopPropagation = (event: React.SyntheticEvent) => {
    event.stopPropagation();
  };

  const handleEditNote = () => {
    editingRef.current = true;
    setOpen(false);
    openBookmarkDialog({ bookmarkId, focus: "notes" });
  };

  // Focus returns to the button when the popover closes, except when the form takes it.
  const handleCloseAutoFocus = (event: Event) => {
    if (editingRef.current) {
      editingRef.current = false;
      event.preventDefault();
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="shrink-0"
          aria-label={t("bookmarkNotes_show")}
          onPointerDown={handleStopPropagation}
          onClick={handleStopPropagation}
        >
          <StickyNote className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 p-3"
        onClick={handleStopPropagation}
        onContextMenu={handleStopPropagation}
        onCloseAutoFocus={handleCloseAutoFocus}
      >
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t("bookmarkNotes_heading")}</p>
        <div className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-sm">
          {segments.map((segment, index) => segment.kind === "link" ? (
            <a
              key={index}
              href={segment.text}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all text-primary underline underline-offset-2"
            >
              {segment.text}
            </a>
          ) : (
            <React.Fragment key={index}>{segment.text}</React.Fragment>
          ))}
        </div>
        <div className="mt-3 flex justify-end">
          <Button type="button" variant="outline" size="xs" onClick={handleEditNote}>
            {t("bookmarkNotes_edit")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
