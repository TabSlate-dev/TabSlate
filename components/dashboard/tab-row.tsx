import React, { useState, useCallback } from "react";
import { useTabsStore } from "@/store/tabs-store";
import { Button } from "@/components/ui/button";
import {
  BookmarkPlus,
  ExternalLink,
  X,
  Check,
  BrushCleaning,
  FolderPlus,
  Ungroup,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { FaviconImage } from "@/components/ui/favicon-image";
import type { BrowserTab } from "@/lib/chrome/tabs";
import { BaseTabRow } from "@/components/dashboard/shared/base-tab-row";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useWorkspaceStore } from "@/store/workspace-store";
import { CollectionDialog } from "@/components/dashboard/sidebar/collection-dialog";
import {
  getActiveWorkspaceCollections,
  isActiveWorkspace,
  resolveActiveWorkspaceCollectionTarget,
} from "@/lib/workspace-visibility";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle } from "lucide-react";
import { useTranslation } from "@/hooks/use-translation";
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
  const { t } = useTranslation();
  // Fine-grained selectors
  const isHighlighted = useTabsStore(s => s.highlightedTabIds.includes(tab.id));
  const closeTab = useTabsStore(s => s.closeTab);
  const focusTab = useTabsStore(s => s.focusTab);
  const addBookmark = useBookmarksStore(s => s.addBookmark);

  const collections = useWorkspaceStore(s => s.collections);
  const workspaces = useWorkspaceStore(s => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore(s => s.activeWorkspaceId);

  const activeCollections = React.useMemo(() => {
    return getActiveWorkspaceCollections(activeWorkspaceId, workspaces, collections);
  }, [activeWorkspaceId, workspaces, collections]);

  const [saved, setSaved] = useState(false);
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);
  const [collectionDialogOpen, setCollectionDialogOpen] = useState(false);
  const [targetUnavailable, setTargetUnavailable] = useState(false);

  const handleSaveToCollection = useCallback((collectionId: string) => {
    const state = useWorkspaceStore.getState();
    const target = resolveActiveWorkspaceCollectionTarget(
      collectionId,
      state.activeWorkspaceId,
      state.workspaces,
      state.collections,
    );
    if (!target) {
      setSaveMenuOpen(false);
      setTargetUnavailable(true);
      return;
    }
    addBookmark({
      title: tab.title,
      url: tab.url,
      favicon: tab.favIconUrl,
      collectionId: target.id,
      description: "",
      tags: [],
      seq: 0,
    });
    setSaved(true);
    setTargetUnavailable(false);
    setTimeout(() => setSaved(false), 2000);
  }, [tab.title, tab.url, tab.favIconUrl, addBookmark]);

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
  const targetAlert = targetUnavailable ? (
    <Alert className="fixed top-4 left-1/2 -translate-x-1/2 z-100 w-auto shadow-lg" variant="destructive">
      <AlertCircle />
      <AlertDescription>{t("workspaceVisibility_targetUnavailable")}</AlertDescription>
    </Alert>
  ) : null;

  const actionsContent = !hideActions && (
    <div className="flex items-center gap-0.5">
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
          className="size-6 text-muted-foreground hover:text-primary"
        >
          <FolderPlus className="size-3" />
        </Button>
      )}
      <DropdownMenu open={saveMenuOpen} onOpenChange={setSaveMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={(e) => e.stopPropagation()}
            title={saved ? "Saved!" : "Save to collection"}
            className={cn("size-6 text-muted-foreground", saved && "text-green-600 hover:text-green-600")}
          >
            {saved ? <Check className="size-3" /> : <BookmarkPlus className="size-3" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48 max-h-64 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
          {activeCollections.map((c) => (
            <DropdownMenuItem key={c.id} onClick={(e) => { e.stopPropagation(); setSaveMenuOpen(false); handleSaveToCollection(c.id); }}>
              <span className="truncate">{c.name}</span>
            </DropdownMenuItem>
          ))}
          {activeCollections.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setSaveMenuOpen(false); setCollectionDialogOpen(true); }}>
            <FolderPlus className="size-3.5 mr-2" />
            New Collection...
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={handleOpen}
        title="Open in new tab"
        className="size-6 text-muted-foreground hover:text-foreground"
      >
        <ExternalLink className="size-3" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={handleClose}
        title="Close tab"
        className="size-6 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
      >
        <X className="size-3" />
      </Button>
    </div>
  );

  if (variant === "card") {
    let hostname = "";
    try {
      hostname = new URL(tab.url).hostname;
    } catch {
      hostname = tab.url;
    }

    return (
      <>
      <div
        className={cn(
          "relative group flex items-start gap-2.5 p-2.5 rounded-xl border bg-card transition-all cursor-pointer hover:shadow-sm hover:border-primary/20",
          tab.active && "border-primary/30 bg-primary/5 shadow-sm",
          selected && "bg-primary/5 ring-1 ring-primary/40 border-primary/40 shadow-sm",
          isHighlighted && "ring-2 ring-amber-500 bg-amber-500/10 border-transparent shadow-md"
        )}
        onClick={handleCardClick}
      >
        {targetAlert}
        {showCheckbox && (
          <div
            className="absolute top-0 right-0 z-10 p-2 cursor-pointer"
            onClick={(e) => {
              e.stopPropagation();
              onSelect?.(!selected);
            }}
          >
            <div
              className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded-sm border border-primary transition-all",
                selected ? "bg-primary text-primary-foreground" : "bg-transparent text-transparent"
              )}
            >
              <Check className={cn("size-3", selected ? "opacity-100" : "opacity-0")} strokeWidth={3} />
            </div>
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
            <DropdownMenu open={saveMenuOpen} onOpenChange={setSaveMenuOpen}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={(e) => e.stopPropagation()}
                  title={saved ? "Saved!" : "Save to collection"}
                  className={cn("size-6 rounded-md", saved && "text-green-600")}
                >
                  {saved ? <Check className="size-3" /> : <BookmarkPlus className="size-3" />}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48 max-h-64 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                {activeCollections.map((c) => (
                  <DropdownMenuItem key={c.id} onClick={(e) => { e.stopPropagation(); setSaveMenuOpen(false); handleSaveToCollection(c.id); }}>
                    <span className="truncate">{c.name}</span>
                  </DropdownMenuItem>
                ))}
                {activeCollections.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setSaveMenuOpen(false); setCollectionDialogOpen(true); }}>
                  <FolderPlus className="size-3.5 mr-2" />
                  New Collection...
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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
      {collectionDialogOpen && (
        <div onClick={(e) => e.stopPropagation()}>
          <CollectionDialog
            open={collectionDialogOpen}
            onOpenChange={setCollectionDialogOpen}
            onSubmit={(name, icon) => {
              const state = useWorkspaceStore.getState();
              const activeWorkspace = state.workspaces.find(
                (workspace) => workspace.id === state.activeWorkspaceId,
              );
              if (!isActiveWorkspace(activeWorkspace)) {
                setTargetUnavailable(true);
                return;
              }
              const newCol = state.createCollection(state.activeWorkspaceId, name, icon);
              handleSaveToCollection(newCol.id);
            }}
          />
        </div>
      )}
      </>
    );
  }

  // Use shared BaseTabRow for the standard "list" variant
  return (
    <>
      {targetAlert}
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
      {collectionDialogOpen && (
        <div onClick={(e) => e.stopPropagation()}>
          <CollectionDialog
            open={collectionDialogOpen}
            onOpenChange={setCollectionDialogOpen}
            onSubmit={(name, icon) => {
              const state = useWorkspaceStore.getState();
              const activeWorkspace = state.workspaces.find(
                (workspace) => workspace.id === state.activeWorkspaceId,
              );
              if (!isActiveWorkspace(activeWorkspace)) {
                setTargetUnavailable(true);
                return;
              }
              const newCol = state.createCollection(state.activeWorkspaceId, name, icon);
              handleSaveToCollection(newCol.id);
            }}
          />
        </div>
      )}
    </>
  );
});
