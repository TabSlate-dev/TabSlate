import React, { useState, useCallback } from "react";
import { useTabsStore } from "@/store/tabs-store";
import { Button } from "@/components/ui/button";
import {
  Bookmark,
  ExternalLink,
  X,
  Check,
  BrushCleaning,
  FolderPlus,
  Ungroup,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { storageService } from "@/lib/storage";
import { FaviconImage } from "@/components/ui/favicon-image";
import type { BrowserTab } from "@/lib/chrome/tabs";
import { BaseTabRow } from "@/components/dashboard/shared/base-tab-row";

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

export const TabRow = React.memo(function TabRow({
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
  // Fine-grained selectors
  const isHighlighted = useTabsStore(s => s.highlightedTabIds.includes(tab.id));
  const closeTab = useTabsStore(s => s.closeTab);
  const focusTab = useTabsStore(s => s.focusTab);

  const [saved, setSaved] = useState(false);

  const handleSave = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    storageService.addBookmark({
      title: tab.title,
      url: tab.url,
      favicon: tab.favIconUrl,
      collectionId: "all",
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, [tab.title, tab.url, tab.favIconUrl]);

  const handleFocus = useCallback((e: React.MouseEvent | React.FormEvent) => {
    e.stopPropagation();
    focusTab(tab.id, tab.windowId);
  }, [focusTab, tab.id, tab.windowId]);

  const handleOpen = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    window.open(tab.url, "_blank");
  }, [tab.url]);

  const handleClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    closeTab(tab.id);
  }, [closeTab, tab.id]);

  const handleCardClick = useCallback((e: React.MouseEvent) => {
    if (variant === "card" && showCheckbox) {
      onSelect?.(!selected);
    } else {
      handleFocus(e);
    }
  }, [variant, showCheckbox, onSelect, selected, handleFocus]);

  // Actions for the row
  const actionsContent = !hideActions && (
    <>
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
    </>
  );

  if (variant === "card") {
    let hostname = "";
    try {
      hostname = new URL(tab.url).hostname;
    } catch {
      hostname = tab.url;
    }

    return (
      <div
        className={cn(
          "relative group flex items-start gap-2.5 p-2.5 rounded-xl border bg-card transition-all cursor-pointer hover:shadow-sm hover:border-primary/20",
          tab.active && "border-primary/30 bg-primary/5 shadow-sm",
          selected && "bg-primary/5 ring-1 ring-primary/40 border-primary/40 shadow-sm",
          isHighlighted && "ring-2 ring-amber-500 bg-amber-500/10 border-transparent shadow-md"
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
                <Ungroup className="size-3 text-destructive" />
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
              <X className="size-3 text-destructive" />
            </Button>
          </div>
        )}
      </div>
    );
  }

  // Use shared BaseTabRow for the standard "list" variant
  return (
    <BaseTabRow
      title={tab.title}
      url={tab.url}
      favicon={tab.favIconUrl}
      active={tab.active}
      selected={selected}
      isHighlighted={isHighlighted}
      showCheckbox={showCheckbox}
      onSelect={onSelect}
      onClick={handleCardClick}
      isUngrouped={isUngrouped}
      actions={actionsContent}
    />
  );
});
