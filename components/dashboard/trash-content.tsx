import * as React from "react";
import { cn } from "@/lib/utils";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { Button } from "@/components/ui/button";
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
} from "lucide-react";
import type { Bookmark as BookmarkType, Collection } from "@/lib/types";

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
}: {
  collection: Collection;
  bookmarks: BookmarkType[];
  selected?: boolean;
  onSelect?: (checked: boolean) => void;
}) {
  const restoreCollection = useWorkspaceStore(s => s.restoreCollection);
  const permanentlyDeleteCollection = useWorkspaceStore(s => s.permanentlyDeleteCollection);
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
          <Button variant="outline" size="sm" onClick={() => restoreCollection(collection.id)}>
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
                onClick={() => permanentlyDeleteCollection(collection.id)}
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
            <TrashedBookmarkCard key={b.id} bookmark={b} isNested />
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
}: {
  bookmark: BookmarkType;
  isNested?: boolean;
  selected?: boolean;
  onSelect?: (checked: boolean) => void;
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
              onClick={() => permanentlyDelete(bookmark.id)}
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

export function TrashContent() {
  const trashedBookmarks = useBookmarksStore(s => s.trashedBookmarks);
  const getTrashedCollections = useWorkspaceStore(s => s.getTrashedCollections);
  const restoreFromTrash = useBookmarksStore(s => s.restoreFromTrash);
  const permanentlyDeleteBookmark = useBookmarksStore(s => s.permanentlyDelete);
  
  const collections = useWorkspaceStore(s => s.collections);
  const activeWorkspaceId = useWorkspaceStore(s => s.activeWorkspaceId);
  const restoreCollection = useWorkspaceStore(s => s.restoreCollection);
  const permanentlyDeleteCollection = useWorkspaceStore(s => s.permanentlyDeleteCollection);

  const trashedCollections = getTrashedCollections();
  const trashedCollectionIds = React.useMemo(
    () => new Set(trashedCollections.map(c => c.id)),
    [trashedCollections]
  );

  const collectionBookmarks = React.useMemo(() => {
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
  }, [trashedBookmarks, trashedCollectionIds]);

  const individualTrashedBookmarks = React.useMemo(() => {
    const unique = new Map<string, BookmarkType>();
    for (const b of trashedBookmarks) {
      if (!trashedCollectionIds.has(b.collectionId)) {
        unique.set(b.id, b);
      }
    }
    return Array.from(unique.values());
  }, [trashedBookmarks, trashedCollectionIds]);

  const totalCount = trashedCollections.length + individualTrashedBookmarks.length;

  const [selectedColIds, setSelectedColIds] = React.useState<Set<string>>(new Set());
  const [selectedBmIds, setSelectedBmIds] = React.useState<Set<string>>(new Set());
  const selectedCount = selectedColIds.size + selectedBmIds.size;

  const toggleCol = (id: string) => {
    setSelectedColIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
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

  const handleSelectAll = () => {
    if (selectedCount === totalCount) {
      setSelectedColIds(new Set());
      setSelectedBmIds(new Set());
    } else {
      setSelectedColIds(new Set(trashedCollections.map(c => c.id)));
      setSelectedBmIds(new Set(individualTrashedBookmarks.map(b => b.id)));
    }
  };

  const handleBatchRestore = () => {
    for (const colId of selectedColIds) {
      restoreCollection(colId);
    }
    const active = collections.filter(
      c => !c.deletedAt && !c.archivedAt && c.workspaceId === activeWorkspaceId,
    );
    const defaultCol = active.find(c => c.isDefault);

    for (const bmId of selectedBmIds) {
      const bm = trashedBookmarks.find(b => b.id === bmId);
      if (!bm) continue;
      let targetColId = defaultCol?.id ?? "";
      if (selectedColIds.has(bm.collectionId)) {
         targetColId = bm.collectionId;
      } else {
        const byId = active.find(c => c.id === bm.collectionId);
        if (byId) {
          targetColId = byId.id;
        } else {
          const srcCol = collections.find(c => c.id === bm.collectionId);
          const byName = srcCol ? active.find(c => c.name === srcCol.name) : undefined;
          if (byName) {
            targetColId = byName.id;
          }
        }
      }
      restoreFromTrash(bmId, targetColId);
    }
    setSelectedColIds(new Set());
    setSelectedBmIds(new Set());
  };

  const handleBatchDelete = () => {
    for (const colId of selectedColIds) {
      permanentlyDeleteCollection(colId);
    }
    for (const bmId of selectedBmIds) {
      permanentlyDeleteBookmark(bmId);
    }
    setSelectedColIds(new Set());
    setSelectedBmIds(new Set());
  };

  const handleEmptyTrash = () => {
    for (const col of trashedCollections) {
      permanentlyDeleteCollection(col.id);
    }
    for (const bm of individualTrashedBookmarks) {
      permanentlyDeleteBookmark(bm.id);
    }
    setSelectedColIds(new Set());
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
                {individualTrashedBookmarks.length} bookmark{individualTrashedBookmarks.length !== 1 ? "s" : ""}
              </p>
            </div>
          </div>
          {totalCount > 0 && selectedCount === 0 && (
            <div className="flex items-center gap-4">
              <p className="text-xs text-muted-foreground hidden md:block mr-2">
                Items in trash will be permanently deleted after 30 days
              </p>
              <Button variant="destructive" size="sm" onClick={handleEmptyTrash}>
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
              <Button variant="outline" size="sm" onClick={() => { setSelectedColIds(new Set()); setSelectedBmIds(new Set()); }}>
                Cancel
              </Button>
              <Button variant="outline" size="sm" onClick={handleSelectAll}>
                {selectedCount === totalCount ? "Deselect All" : "Select All"}
              </Button>
              <Button size="sm" onClick={handleBatchRestore}>
                <RotateCcw className="size-4 mr-1" /> Restore
              </Button>
              <Button size="sm" variant="destructive" onClick={handleBatchDelete}>
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
            />
          ))}
        </div>

        {totalCount === 0 && (
          <EmptyState
            icon={Trash2}
            title="Trash is empty"
            description="Deleted bookmarks and collections will appear here."
          />
        )}
      </div>
    </div>
  );
}
