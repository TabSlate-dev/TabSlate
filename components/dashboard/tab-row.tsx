import { useState } from "react";
import { useTabsStore } from "@/store/tabs-store";
import { Button } from "@/components/ui/button";
import {
  Bookmark,
  ExternalLink,
  X,
  Check,
  Globe,
  BrushCleaning,
  FolderPlus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { storageService } from "@/lib/storage";
import { FaviconImage } from "@/components/ui/favicon-image";
import type { BrowserTab } from "@/lib/chrome/tabs";


interface TabRowProps {
  tab: BrowserTab;
  selected?: boolean;
  onSelect?: (checked: boolean) => void;
  showCheckbox?: boolean;
  hideActions?: boolean;
  variant?: "list" | "card";
  onUngroup?: () => void;
  onJoinGroup?: () => void;
  isUngrouped?: boolean;
}

export function TabRow({
  tab,
  selected,
  onSelect,
  showCheckbox,
  hideActions = false,
  variant = "list",
  onUngroup,
  onJoinGroup,
  isUngrouped,
}: TabRowProps) {
  const { closeTab, focusTab } = useTabsStore();
  const [saved, setSaved] = useState(false);

  const handleSave = (e: React.MouseEvent) => {
    e.stopPropagation();
    storageService.addBookmark({
      title: tab.title,
      url: tab.url,
      favicon: tab.favIconUrl,
      collectionId: "all",
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleFocus = (e: React.MouseEvent | React.FormEvent) => {
    e.stopPropagation();
    focusTab(tab.id, tab.windowId);
  };

  const handleOpen = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.open(tab.url, "_blank");
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    closeTab(tab.id);
  };

  const handleCardClick = (e: React.MouseEvent) => {
    // For card variant (dialogs), whole area toggles selection
    if (variant === "card" && showCheckbox) {
      onSelect?.(!selected);
    } else {
      // For list variant (main panel), only handle focus
      handleFocus(e);
    }
  };

  if (variant === "card") {
    let hostname = "";
    try {
      hostname = new URL(tab.url).hostname;
    } catch (e) {
      hostname = tab.url;
    }

    return (
      <div
        className={cn(
          "relative group flex items-start gap-2.5 p-2.5 rounded-xl border bg-card transition-all cursor-pointer hover:shadow-sm hover:border-primary/20",
          tab.active && "border-primary/30 bg-primary/5 shadow-sm",
          selected && "bg-primary/5 ring-1 ring-primary/40 border-primary/40 shadow-sm"
        )}
        onClick={handleCardClick}
      >
        {showCheckbox && (
          <div
            className={cn(
              "absolute top-2 right-2 z-10 flex size-4 shrink-0 items-center justify-center rounded-sm border border-primary transition-all",
              selected ? "bg-primary text-primary-foreground" : "bg-transparent text-transparent"
            )}
            onClick={(e) => {
              e.stopPropagation();
              onSelect?.(!selected);
            }}
          >
            <Check className={cn("size-3", selected ? "opacity-100" : "opacity-0")} strokeWidth={3} />
          </div>
        )}

        <div className="relative shrink-0 mt-0.5">
          <FaviconImage src={tab.favIconUrl} className="size-4.5 rounded-sm shadow-sm" />
          {tab.active && (
            <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-green-500 ring-1 ring-background shadow-sm" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <p className={cn("text-[13px] font-medium truncate leading-tight transition-colors group-hover:text-primary", tab.active && "text-primary")}>
            {tab.title}
          </p>
          <div className="flex items-center gap-1 mt-0.5 text-[10px] text-muted-foreground/70">
            <span className="truncate">{hostname}</span>
          </div>
        </div>

        {!hideActions && (
          <div className="flex items-center gap-0.5 opacity-100 shrink-0 ml-1">
            {tab.groupId !== -1 ? (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={(e) => { e.stopPropagation(); onUngroup?.(); }}
                title="Ungroup tab"
                className="size-6 rounded-md text-destructive hover:bg-destructive/10"
              >
                <BrushCleaning className="size-3" />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={(e) => { e.stopPropagation(); onJoinGroup?.(); }}
                title="Join group"
                className="size-6 rounded-md"
              >
                <FolderPlus className="size-3" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={handleSave}
              title={saved ? "Saved!" : "Save"}
              className={cn("size-6 rounded-md", saved && "text-green-600")}
            >
              {saved ? <Check className="size-3" /> : <Bookmark className="size-3" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={handleOpen}
              title="Open"
              className="size-6 rounded-md"
            >
              <ExternalLink className="size-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={handleClose}
              title="Close tab"
              className="size-6 rounded-md hover:text-destructive"
            >
              <X className="size-3" />
            </Button>
          </div>
        )}
      </div>
    );
  }

  // Default "list" variant
  return (
    <div
      className={cn(
        "group relative flex items-center gap-2.5 px-3 py-2 transition-all cursor-pointer",
        !isUngrouped && "rounded-md hover:bg-accent/50",
        selected && !isUngrouped && "bg-accent/40",
        tab.active && !selected && !isUngrouped && "bg-blue-50/60 dark:bg-blue-950/20"
      )}
      onClick={handleCardClick}
    >
      {isUngrouped && (
        <div
          className={cn(
            "absolute inset-x-0.5 inset-y-0.5 rounded-md pointer-events-none transition-colors",
            selected ? "bg-accent/50" : "group-hover:bg-accent/40"
          )}
        />
      )}
      {showCheckbox && (
        <div
          className={cn(
            "shrink-0 mr-1 flex size-4 items-center justify-center rounded-sm border border-primary transition-all",
            selected ? "bg-primary text-primary-foreground" : "bg-transparent text-transparent"
          )}
          onClick={(e) => {
            e.stopPropagation();
            onSelect?.(!selected);
          }}
        >
          <Check className={cn("size-3", selected ? "opacity-100" : "opacity-0")} strokeWidth={3} />
        </div>
      )}

      {/* Favicon */}
      <div className="size-6 rounded bg-muted flex items-center justify-center shrink-0 overflow-hidden">
        <FaviconImage src={tab.favIconUrl} className="size-4" />
      </div>

      {/* Title */}
      <button
        type="button"
        className="flex-1 min-w-0 text-left"
        onClick={handleFocus}
        title={tab.url}
      >
        <p className={cn("text-sm truncate", tab.active && "font-medium")}>
          {tab.title}
        </p>
      </button>

      {/* Hover actions */}
      {!hideActions && (
        <div className="flex items-center gap-0.5 opacity-100 shrink-0">
          {tab.groupId !== -1 ? (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={(e) => { e.stopPropagation(); onUngroup?.(); }}
              title="Ungroup tab"
              className="size-6 text-destructive hover:bg-destructive/10"
            >
              <BrushCleaning className="size-3" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={(e) => { e.stopPropagation(); onJoinGroup?.(); }}
              title="Join group"
              className="size-6"
            >
              <FolderPlus className="size-3" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleSave}
            title={saved ? "Saved!" : "Save bookmark"}
            className={cn("size-6", saved && "text-green-600")}
          >
            {saved ? <Check className="size-3" /> : <Bookmark className="size-3" />}
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleOpen}
            title="Open in new tab"
            className="size-6"
          >
            <ExternalLink className="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleClose}
            title="Close tab"
            className="size-6 hover:text-destructive"
          >
            <X className="size-3" />
          </Button>
        </div>
      )}
    </div>
  );
}
