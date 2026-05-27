import * as React from "react";
import { cn } from "@/lib/utils";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { useGroupsStore, type SavedGroup, type GroupTab } from "@/store/groups-store";
import { TAB_GROUP_COLORS } from "@/lib/chrome/tab-groups";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FaviconImage } from "@/components/ui/favicon-image";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Bookmark,
  BookOpen,
  Code,
  Folder,
  Globe,
  Heart,
  Inbox,
  MoreHorizontal,
  Palette,
  RotateCcw,
  Sparkles,
  Star,
  Trash2,
  Wrench,
  XCircle,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  Check,
  Layers,
} from "lucide-react";
import type { Bookmark as BookmarkType, Collection } from "@/lib/types";
import { usePlanStore } from "@/store/plan-store";

// ---------------------------------------------------------------------------
// Icon map (mirrors sidebar)
// ---------------------------------------------------------------------------
const ICON_MAP: Record<string, React.ElementType> = {
  folder: Folder,
  bookmark: Bookmark,
  code: Code,
  palette: Palette,
  wrench: Wrench,
  "book-open": BookOpen,
  sparkles: Sparkles,
  star: Star,
  heart: Heart,
  globe: Globe,
  inbox: Inbox,
};

function CollectionIcon({ icon, className }: { icon: string; className?: string }) {
  const Icon = ICON_MAP[icon] ?? Folder;
  return <Icon className={className ?? "size-4"} />;
}

function TrashedCollectionCard({
  collection,
  bookmarks,
  selected,
  onSelect,
  selectedBmIds,
  onToggleBm,
  onPermanentlyDelete,
}: {
  collection: Collection;
  bookmarks: BookmarkType[];
  selected?: boolean;
  onSelect?: (checked: boolean) => void;
  selectedBmIds?: Set<string>;
  onToggleBm?: (id: string) => void;
  onPermanentlyDelete: () => void;
}) {
  const restoreCollection = useWorkspaceStore(s => s.restoreCollection);
  const [expanded, setExpanded] = React.useState(false);

  return (
    <div className="flex flex-col rounded-lg border bg-card overflow-hidden">
      <div
        className="flex items-center gap-4 p-4 hover:bg-accent/50 transition-colors opacity-75 hover:opacity-100 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        {onSelect && (
          <div
            className={cn(
              "flex size-4 shrink-0 items-center justify-center rounded-sm border border-primary transition-all cursor-pointer",
              selected ? "bg-primary text-primary-foreground" : "bg-transparent text-transparent"
            )}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(!selected);
            }}
          >
            <Check className={cn("size-3", selected ? "opacity-100" : "opacity-0")} strokeWidth={3} />
          </div>
        )}
        <div className="size-10 rounded-lg bg-muted flex items-center justify-center shrink-0">
          <CollectionIcon icon={collection.icon} className="size-5 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <h3 className="font-medium truncate">{collection.name}</h3>
            {expanded ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
          </div>
          <p className="text-sm text-muted-foreground">
            {bookmarks.length} bookmark{bookmarks.length !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
          <Button 
            variant="outline" 
            size="sm" 
            onClick={() => {
              restoreCollection(collection.id);
              // Restore ALL bookmarks currently in this collection, ignoring selection
              bookmarks.forEach(b => {
                useBookmarksStore.getState().restoreFromTrash(b.id, collection.id);
              });
            }}
          >
            <RotateCcw className="size-4 mr-1" />
            Restore
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={onPermanentlyDelete}
              >
                <XCircle className="size-4 mr-2" />
                Delete Permanently
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {expanded && bookmarks.length > 0 && (
        <div className="flex flex-col border-t bg-card/30 divide-y divide-border/50">
          {bookmarks.map((b) => (
            <TrashedBookmarkCard
              key={b.id}
              bookmark={b}
              isNested
              selected={selectedBmIds?.has(b.id)}
              onSelect={onToggleBm ? () => onToggleBm(b.id) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TrashedBookmarkCard({
  bookmark,
  isNested,
  selected,
  onSelect,
  onPermanentlyDelete,
}: {
  bookmark: BookmarkType;
  isNested?: boolean;
  selected?: boolean;
  onSelect?: (checked: boolean) => void;
  onPermanentlyDelete?: () => void;
}) {
  const restoreFromTrash = useBookmarksStore(s => s.restoreFromTrash);
  const permanentlyDelete = useBookmarksStore(s => s.permanentlyDelete);
  const collections = useWorkspaceStore(s => s.collections);
  const activeWorkspaceId = useWorkspaceStore(s => s.activeWorkspaceId);

  function handleRestore() {
    const active = collections.filter(
      c => !c.deletedAt && !c.archivedAt && c.workspaceId === activeWorkspaceId,
    );

    // 1. collectionId still points to an active collection
    const byId = active.find(c => c.id === bookmark.collectionId);
    if (byId) {
      restoreFromTrash(bookmark.id, byId.id);
      return;
    }

    // 2. Original collection name exists under a different id (e.g. re-created)
    const srcCol = collections.find(c => c.id === bookmark.collectionId);
    const byName = srcCol ? active.find(c => c.name === srcCol.name) : undefined;
    if (byName) {
      restoreFromTrash(bookmark.id, byName.id);
      return;
    }

    // 3. Fall back to default collection
    const defaultCol = active.find(c => c.isDefault);
    restoreFromTrash(bookmark.id, defaultCol?.id ?? "");
  }

  return (
    <div className={cn(
      "group flex items-center gap-4 p-4 hover:bg-accent/50 transition-colors opacity-75 hover:opacity-100",
      !isNested && "rounded-lg border bg-card",
      onSelect && "cursor-pointer"
    )} onClick={() => onSelect?.(!selected)}>
      {onSelect && (
        <div
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-sm border border-primary transition-all cursor-pointer",
            selected ? "bg-primary text-primary-foreground" : "bg-transparent text-transparent"
          )}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(!selected);
          }}
        >
          <Check className={cn("size-3", selected ? "opacity-100" : "opacity-0")} strokeWidth={3} />
        </div>
      )}
      <div className="size-10 rounded-lg bg-muted flex items-center justify-center overflow-hidden shrink-0">
        <FaviconImage
          src={bookmark.favicon}
          alt={bookmark.title}
          className="size-6 grayscale"
          hasDarkIcon={bookmark.hasDarkIcon}
        />
      </div>

      <div className="flex-1 min-w-0">
        <h3 className="font-medium truncate">{bookmark.title}</h3>
        <p className="text-sm text-muted-foreground truncate">{bookmark.url}</p>
      </div>

      <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
        <Button variant="outline" size="sm" onClick={handleRestore}>
          <RotateCcw className="size-4 mr-1" />
          Restore
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => window.open(bookmark.url, "_blank")}>
              <ExternalLink className="size-4 mr-2" />
              Open URL
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive"
              onClick={() => onPermanentlyDelete ? onPermanentlyDelete() : permanentlyDelete(bookmark.id)}
            >
              <XCircle className="size-4 mr-2" />
              Delete Permanently
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function TrashedGroupCard({
  group,
  tabs,
  isGroupSelected,
  onToggleGroup,
  selectedTabIds,
  onToggleTab,
  onPermanentlyDeleteGroup,
  onPermanentlyDeleteTab,
}: {
  group: SavedGroup;
  tabs: GroupTab[];
  isGroupSelected: boolean;
  onToggleGroup: () => void;
  selectedTabIds: Set<string>;
  onToggleTab: (tabId: string) => void;
  onPermanentlyDeleteGroup: () => void;
  onPermanentlyDeleteTab: (tabId: string) => void;
}) {
  const restoreGroup = useGroupsStore(s => s.restoreGroup);
  const createGroup = useGroupsStore(s => s.createGroup);
  const addTabToGroup = useGroupsStore(s => s.addTabToGroup);
  const deleteTabFromTrash = useGroupsStore(s => s.deleteTabFromTrash);
  const [expanded, setExpanded] = React.useState(false);

  const handleRestoreTab = (tab: GroupTab) => {
    const activeGroups = useGroupsStore.getState().groups;
    const { activeWorkspaceId } = useWorkspaceStore.getState();
    const existing = activeGroups.find(g => g.name === group.name && !g.deletedAt);
    const targetId = existing ? existing.id : createGroup(group.name, group.color, group.isCompact, activeWorkspaceId);
    addTabToGroup(targetId, { title: tab.title, url: tab.url, favicon: tab.favicon });
    deleteTabFromTrash(tab.id);
  };

  return (
    <div className="flex flex-col rounded-lg border bg-card overflow-hidden">
      <div
        className="flex items-center gap-4 p-4 hover:bg-accent/50 transition-colors opacity-75 hover:opacity-100 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <div
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-sm border border-primary transition-all cursor-pointer",
            isGroupSelected ? "bg-primary text-primary-foreground" : "bg-transparent text-transparent"
          )}
          onClick={(e) => { e.stopPropagation(); onToggleGroup(); }}
        >
          <Check className={cn("size-3", isGroupSelected ? "opacity-100" : "opacity-0")} strokeWidth={3} />
        </div>
        <div className="size-10 rounded-lg bg-muted flex items-center justify-center shrink-0">
          <Layers className="size-5 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="size-2.5 rounded-full shrink-0"
              style={{ backgroundColor: TAB_GROUP_COLORS[group.color] }}
            />
            <div className="flex items-center gap-1">
              <h3 className="font-medium truncate">{group.name}</h3>
              {tabs.length > 0 && (expanded ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />)}
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            {tabs.length} tab{tabs.length !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
          <Button variant="outline" size="sm" onClick={() => restoreGroup(group.id)}>
            <RotateCcw className="size-4 mr-1" />
            Restore
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={onPermanentlyDeleteGroup}
              >
                <XCircle className="size-4 mr-2" />
                Delete Permanently
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {expanded && tabs.length > 0 && (
        <div className="flex flex-col border-t bg-card/30 divide-y divide-border/50">
          {[...tabs].sort((a, b) => a.position - b.position).map(tab => {
            const tabSelected = selectedTabIds.has(tab.id);
            return (
              <div
                key={tab.id}
                className="flex items-center gap-3 px-4 py-2.5 opacity-75 hover:opacity-100 hover:bg-accent/30 cursor-pointer"
                onClick={() => onToggleTab(tab.id)}
              >
                <div
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-sm border border-primary transition-all",
                    tabSelected ? "bg-primary text-primary-foreground" : "bg-transparent text-transparent"
                  )}
                >
                  <Check className={cn("size-3", tabSelected ? "opacity-100" : "opacity-0")} strokeWidth={3} />
                </div>
                <FaviconImage src={tab.favicon} alt={tab.title} className="size-4 grayscale shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{tab.title}</p>
                  <p className="text-xs text-muted-foreground truncate">{tab.url}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleRestoreTab(tab)}
                  >
                    <RotateCcw className="size-3.5 mr-1" />
                    Restore
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-xs">
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => onPermanentlyDeleteTab(tab.id)}
                      >
                        <XCircle className="size-4 mr-2" />
                        Delete Permanently
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function TrashContent() {
  React.useEffect(() => {
    void useBookmarksStore.getState().loadTrashedBookmarks();
  }, []);

  const trashedBookmarks = useBookmarksStore(s => s.trashedBookmarks);
  const restoreFromTrash = useBookmarksStore(s => s.restoreFromTrash);
  const permanentlyDeleteBookmark = useBookmarksStore(s => s.permanentlyDelete);
  const permanentlyDeleteBookmarkBatch = useBookmarksStore(s => s.permanentlyDeleteBatch);
  
  const collections = useWorkspaceStore(s => s.collections);
  const workspaces = useWorkspaceStore(s => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore(s => s.activeWorkspaceId);
  const restoreCollection = useWorkspaceStore(s => s.restoreCollection);
  const trashGraceDays = usePlanStore(s => s.limits?.trash_grace_days ?? 30);
  const permanentlyDeleteCollection = useWorkspaceStore(s => s.permanentlyDeleteCollection);

  const allGroups = useGroupsStore(s => s.groups);
  const allGroupTabs = useGroupsStore(s => s.groupTabs);
  const restoreGroup = useGroupsStore(s => s.restoreGroup);
  const permanentlyDeleteGroup = useGroupsStore(s => s.permanentlyDeleteGroup);
  const createGroup = useGroupsStore(s => s.createGroup);
  const addTabToGroup = useGroupsStore(s => s.addTabToGroup);
  const deleteTabFromTrash = useGroupsStore(s => s.deleteTabFromTrash);
  const trashedGroups = React.useMemo(
    () => allGroups.filter(g => !!g.deletedAt && g.workspaceId === activeWorkspaceId),
    [allGroups, activeWorkspaceId]
  );

  const groupTabsMap = React.useMemo(() => {
    const map: Record<string, GroupTab[]> = {};
    for (const t of allGroupTabs) {
      if (!map[t.groupId]) { map[t.groupId] = []; }
      map[t.groupId].push(t);
    }
    return map;
  }, [allGroupTabs]);

  const wsAllColIds = React.useMemo(
    () => new Set(collections.filter(c => c.workspaceId === activeWorkspaceId).map(c => c.id)),
    [collections, activeWorkspaceId]
  );

  const workspaceIds = React.useMemo(
    () => new Set(workspaces.map(w => w.id)),
    [workspaces]
  );

  const trashedCollections = React.useMemo(
    () => collections.filter(
      c => !!c.deletedAt && (c.workspaceId === activeWorkspaceId || !workspaceIds.has(c.workspaceId))
    ),
    [collections, activeWorkspaceId, workspaceIds]
  );

  const individualTrashedBookmarks = React.useMemo(() => {
    const trashedCollectionIds = new Set(trashedCollections.map(c => c.id));
    const unique = new Map<string, BookmarkType>();
    for (const b of trashedBookmarks) {
      if (!trashedCollectionIds.has(b.collectionId) && (b.collectionId === "" || wsAllColIds.has(b.collectionId))) {
        unique.set(b.id, b);
      }
    }
    return Array.from(unique.values());
  }, [trashedBookmarks, trashedCollections, wsAllColIds]);

  const collectionBookmarks = React.useMemo(() => {
    const trashedCollectionIds = new Set(trashedCollections.map(c => c.id));
    const map: Record<string, BookmarkType[]> = {};
    const seen = new Set<string>();
    for (const b of trashedBookmarks) {
      if (trashedCollectionIds.has(b.collectionId)) {
        if (seen.has(b.id)) continue;
        seen.add(b.id);
        if (!map[b.collectionId]) map[b.collectionId] = [];
        map[b.collectionId].push(b);
      }
    }
    return map;
  }, [trashedBookmarks, trashedCollections]);

  const totalCount = trashedCollections.length + trashedGroups.length + individualTrashedBookmarks.length;

  const [selectedColIds, setSelectedColIds] = React.useState<Set<string>>(new Set());
  // Full group selection (group header checkbox — all tabs selected)
  const [selectedGroupIds, setSelectedGroupIds] = React.useState<Set<string>>(new Set());
  // Individual tab selection across all trashed groups
  const [selectedTabIds, setSelectedTabIds] = React.useState<Set<string>>(new Set());
  const [selectedBmIds, setSelectedBmIds] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    setSelectedColIds(new Set());
    setSelectedGroupIds(new Set());
    setSelectedTabIds(new Set());
    setSelectedBmIds(new Set());
  }, [activeWorkspaceId]);

  // A group counts as "touched" if fully selected OR has any individually selected tabs.
  const groupsWithSelection = React.useMemo(() => {
    const ids = new Set(selectedGroupIds);
    for (const tabId of selectedTabIds) {
      const tab = allGroupTabs.find(t => t.id === tabId);
      if (tab) { ids.add(tab.groupId); }
    }
    return ids;
  }, [selectedGroupIds, selectedTabIds, allGroupTabs]);

  const selectedCount = selectedColIds.size + groupsWithSelection.size + selectedBmIds.size;

  const toggleCol = (id: string) => {
    setSelectedColIds(prev => {
      const next = new Set(prev);
      const isSelecting = !next.has(id);
      if (isSelecting) next.add(id);
      else next.delete(id);

      const bmsInCol = collectionBookmarks[id] || [];
      setSelectedBmIds(prevBm => {
        const nextBm = new Set(prevBm);
        for (const bm of bmsInCol) {
          if (isSelecting) nextBm.add(bm.id);
          else nextBm.delete(bm.id);
        }
        return nextBm;
      });

      return next;
    });
  };

  // Toggle all tabs in a group (group header checkbox)
  const toggleGroup = (groupId: string) => {
    const tabs = groupTabsMap[groupId] ?? [];
    const isFullySelected = selectedGroupIds.has(groupId);
    if (isFullySelected) {
      setSelectedGroupIds(prev => { const next = new Set(prev); next.delete(groupId); return next; });
      setSelectedTabIds(prev => {
        const next = new Set(prev);
        for (const t of tabs) { next.delete(t.id); }
        return next;
      });
    } else {
      setSelectedGroupIds(prev => new Set([...prev, groupId]));
      setSelectedTabIds(prev => {
        const next = new Set(prev);
        for (const t of tabs) { next.add(t.id); }
        return next;
      });
    }
  };

  // Toggle a single tab; auto-promote group to full selection when all tabs selected
  const toggleTab = (tabId: string) => {
    const tab = allGroupTabs.find(t => t.id === tabId);
    if (!tab) { return; }
    const groupTabs = groupTabsMap[tab.groupId] ?? [];
    setSelectedTabIds(prev => {
      const next = new Set(prev);
      if (next.has(tabId)) {
        next.delete(tabId);
        setSelectedGroupIds(prevG => { const nextG = new Set(prevG); nextG.delete(tab.groupId); return nextG; });
      } else {
        next.add(tabId);
        if (groupTabs.every(t => next.has(t.id))) {
          setSelectedGroupIds(prevG => new Set([...prevG, tab.groupId]));
        }
      }
      return next;
    });
  };

  const toggleBm = (id: string) => {
    setSelectedBmIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const [confirmDialog, setConfirmDialog] = React.useState<{
    title: string;
    description: string;
    onConfirm: () => void;
  } | null>(null);

  const requestConfirm = (title: string, description: string, onConfirm: () => void) => {
    setConfirmDialog({ title, description, onConfirm });
  };

  const handleSelectAll = () => {
    if (selectedCount === totalCount) {
      setSelectedColIds(new Set());
      setSelectedGroupIds(new Set());
      setSelectedTabIds(new Set());
      setSelectedBmIds(new Set());
    } else {
      setSelectedColIds(new Set(trashedCollections.map(c => c.id)));
      setSelectedGroupIds(new Set(trashedGroups.map(g => g.id)));
      setSelectedTabIds(new Set(
        allGroupTabs.filter(t => trashedGroups.some(g => g.id === t.groupId)).map(t => t.id)
      ));
      setSelectedBmIds(new Set(individualTrashedBookmarks.map(b => b.id)));
    }
  };

  const handleBatchRestore = () => {
    const { collections, activeWorkspaceId } = useWorkspaceStore.getState();
    const active = collections.filter(
      c => !c.deletedAt && !c.archivedAt && c.workspaceId === activeWorkspaceId,
    );
    const defaultCol = active.find(c => c.isDefault);

    // 1. Restore selected collections first
    for (const colId of selectedColIds) {
      restoreCollection(colId);
      const allBmsInCol = collectionBookmarks[colId] || [];
      for (const bm of allBmsInCol) {
        if (!selectedBmIds.has(bm.id)) {
          useBookmarksStore.getState().updateBookmark(bm.id, { collectionId: "" });
        }
      }
    }

    // 2a. Fully-selected groups → restore as-is
    for (const groupId of selectedGroupIds) {
      restoreGroup(groupId);
    }

    // 2b. Partially-selected groups → new group with same name/color, selected tabs only
    const partialGroups = trashedGroups.filter(
      g => !selectedGroupIds.has(g.id) && (groupTabsMap[g.id] ?? []).some(t => selectedTabIds.has(t.id))
    );
    const activeGroupsSnap = useGroupsStore.getState().groups;
    for (const group of partialGroups) {
      const tabsToRestore = (groupTabsMap[group.id] ?? []).filter(t => selectedTabIds.has(t.id));
      const existing = activeGroupsSnap.find(g => g.name === group.name && !g.deletedAt);
      const targetId = existing ? existing.id : createGroup(group.name, group.color, group.isCompact, activeWorkspaceId);
      for (const tab of tabsToRestore) {
        addTabToGroup(targetId, { title: tab.title, url: tab.url, favicon: tab.favicon });
        deleteTabFromTrash(tab.id);
      }
    }

    // 3. Restore selected bookmarks
    for (const bmId of selectedBmIds) {
      const bm = trashedBookmarks.find(b => b.id === bmId);
      if (!bm) { continue; }

      let targetColId = defaultCol?.id ?? "";
      if (selectedColIds.has(bm.collectionId)) {
        targetColId = bm.collectionId;
      } else {
        const isAlreadyActive = active.find(c => c.id === bm.collectionId);
        if (isAlreadyActive) {
          targetColId = isAlreadyActive.id;
        } else {
          const srcCol = collections.find(c => c.id === bm.collectionId);
          const byName = srcCol ? active.find(c => c.name === srcCol.name) : undefined;
          if (byName) { targetColId = byName.id; }
        }
      }
      restoreFromTrash(bmId, targetColId);
    }

    setSelectedColIds(new Set());
    setSelectedGroupIds(new Set());
    setSelectedTabIds(new Set());
    setSelectedBmIds(new Set());
  };

  const handleBatchDelete = () => {
    for (const colId of selectedColIds) {
      permanentlyDeleteCollection(colId);
    }
    // Fully-selected groups → delete entire group (including remaining tabs)
    for (const groupId of selectedGroupIds) {
      permanentlyDeleteGroup(groupId);
    }
    // Partial tab selections → delete only those individual tabs
    for (const tabId of selectedTabIds) {
      const tab = allGroupTabs.find(t => t.id === tabId);
      if (tab && !selectedGroupIds.has(tab.groupId)) {
        deleteTabFromTrash(tabId);
      }
    }
    // Batch all selected bookmarks into one push (≤900 per request) instead of N requests.
    if (selectedBmIds.size > 0) {
      permanentlyDeleteBookmarkBatch(Array.from(selectedBmIds));
    }
    setSelectedColIds(new Set());
    setSelectedGroupIds(new Set());
    setSelectedTabIds(new Set());
    setSelectedBmIds(new Set());
  };

  const handleEmptyTrash = () => {
    for (const col of trashedCollections) {
      permanentlyDeleteCollection(col.id);
    }
    for (const group of trashedGroups) {
      permanentlyDeleteGroup(group.id);
    }
    // Batch all individual bookmarks into one push (≤900 per request) instead of N requests.
    if (individualTrashedBookmarks.length > 0) {
      permanentlyDeleteBookmarkBatch(individualTrashedBookmarks.map((b) => b.id));
    }
    setSelectedColIds(new Set());
    setSelectedGroupIds(new Set());
    setSelectedTabIds(new Set());
    setSelectedBmIds(new Set());
  };

  return (
    <div className="flex-1 w-full overflow-auto">
      <div className="p-4 md:p-6 space-y-6">
        <div className="flex items-center justify-between gap-4 p-4 rounded-xl border bg-card">
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-lg bg-destructive/10 text-destructive flex items-center justify-center">
              <Trash2 className="size-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Trash</h2>
              <p className="text-sm text-muted-foreground">
                {trashedCollections.length > 0 && `${trashedCollections.length} collection${trashedCollections.length !== 1 ? "s" : ""}, `}
                {trashedGroups.length > 0 && `${trashedGroups.length} group${trashedGroups.length !== 1 ? "s" : ""}, `}
                {individualTrashedBookmarks.length} bookmark{individualTrashedBookmarks.length !== 1 ? "s" : ""}
              </p>
            </div>
          </div>
          {totalCount > 0 && selectedCount === 0 && (
            <div className="flex items-center gap-4">
              <p className="text-xs text-muted-foreground hidden md:block mr-2">
                Items in trash will be permanently deleted after {trashGraceDays} days
              </p>
              <Button variant="destructive" size="sm" onClick={() => requestConfirm(
                "Empty Trash?",
                "All items in trash will be permanently deleted. This cannot be undone.",
                handleEmptyTrash
              )}>
                Empty Trash
              </Button>
              <Button variant="outline" size="sm" onClick={handleSelectAll}>
                Select All
              </Button>
            </div>
          )}

          {selectedCount > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium mr-2 hidden sm:inline-block">{selectedCount} selected</span>
              <Button variant="outline" size="sm" onClick={() => { setSelectedColIds(new Set()); setSelectedGroupIds(new Set()); setSelectedTabIds(new Set()); setSelectedBmIds(new Set()); }}>
                Cancel
              </Button>
              <Button variant="outline" size="sm" onClick={handleSelectAll}>
                {selectedCount === totalCount ? "Deselect All" : "Select All"}
              </Button>
              <Button size="sm" onClick={handleBatchRestore}>
                <RotateCcw className="size-4 mr-1" /> Restore
              </Button>
              <Button size="sm" variant="destructive" onClick={() => requestConfirm(
                `Delete ${selectedCount} item${selectedCount !== 1 ? "s" : ""} permanently?`,
                "These items will be permanently deleted and cannot be recovered.",
                handleBatchDelete
              )}>
                <Trash2 className="size-4 mr-1" /> Delete
              </Button>
            </div>
          )}
        </div>

        {trashedCollections.length > 0 && (
          <div className="flex flex-col gap-2">
            {trashedCollections.map(col => (
              <TrashedCollectionCard
                key={col.id}
                collection={col}
                bookmarks={collectionBookmarks[col.id] || []}
                selected={selectedColIds.has(col.id)}
                onSelect={() => toggleCol(col.id)}
                selectedBmIds={selectedBmIds}
                onToggleBm={toggleBm}
                onPermanentlyDelete={() => requestConfirm(
                  "Delete collection permanently?",
                  `"${col.name}" and all its bookmarks will be permanently deleted.`,
                  () => permanentlyDeleteCollection(col.id)
                )}
              />
            ))}
          </div>
        )}

        {trashedGroups.length > 0 && (
          <div className="flex flex-col gap-2">
            {trashedGroups.map(group => (
              <TrashedGroupCard
                key={group.id}
                group={group}
                tabs={groupTabsMap[group.id] ?? []}
                isGroupSelected={selectedGroupIds.has(group.id)}
                onToggleGroup={() => toggleGroup(group.id)}
                selectedTabIds={selectedTabIds}
                onToggleTab={toggleTab}
                onPermanentlyDeleteGroup={() => requestConfirm(
                  "Delete group permanently?",
                  `"${group.name}" and all its tabs will be permanently deleted.`,
                  () => permanentlyDeleteGroup(group.id)
                )}
                onPermanentlyDeleteTab={(tabId) => requestConfirm(
                  "Delete tab permanently?",
                  "This tab will be permanently deleted and cannot be recovered.",
                  () => deleteTabFromTrash(tabId)
                )}
              />
            ))}
          </div>
        )}

        <div className="flex flex-col gap-2">
          {individualTrashedBookmarks.map((bookmark) => (
            <TrashedBookmarkCard
              key={bookmark.id}
              bookmark={bookmark}
              selected={selectedBmIds.has(bookmark.id)}
              onSelect={() => toggleBm(bookmark.id)}
              onPermanentlyDelete={() => requestConfirm(
                "Delete bookmark permanently?",
                `"${bookmark.title}" will be permanently deleted and cannot be recovered.`,
                () => permanentlyDeleteBookmark(bookmark.id)
              )}
            />
          ))}
        </div>

        {totalCount === 0 && (
          <EmptyState
            icon={Trash2}
            title="Trash is empty"
            description="Deleted bookmarks, collections, and groups will appear here."
          />
        )}
      </div>

      <Dialog open={!!confirmDialog} onOpenChange={(open) => { if (!open) { setConfirmDialog(null); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{confirmDialog?.title}</DialogTitle>
            <DialogDescription>{confirmDialog?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDialog(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => { confirmDialog?.onConfirm(); setConfirmDialog(null); }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
