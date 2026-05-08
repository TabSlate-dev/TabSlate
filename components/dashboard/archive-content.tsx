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
import { TagList } from "@/components/ui/tag-list";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Archive,
  Bookmark,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
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
  ExternalLink,
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

function ArchivedCollectionCard({
  collection,
  bookmarks,
  selected,
  onSelect,
  selectedBmIds,
  onToggleBm,
}: {
  collection: Collection;
  bookmarks: BookmarkType[];
  selected?: boolean;
  onSelect?: (checked: boolean) => void;
  selectedBmIds?: Set<string>;
  onToggleBm?: (id: string) => void;
}) {
  const restoreCollection = useWorkspaceStore(s => s.restoreCollection);
  const deleteCollection = useWorkspaceStore(s => s.deleteCollection);
  const [expanded, setExpanded] = React.useState(false);

  return (
    <div className="flex flex-col rounded-lg border bg-card overflow-hidden">
      <div
        className="flex items-center gap-4 p-4 hover:bg-accent/50 transition-colors cursor-pointer"
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
                onClick={() => deleteCollection(collection.id)}
              >
                <Trash2 className="size-4 mr-2" />
                Move to Trash
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {expanded && bookmarks.length > 0 && (
        <div className="flex flex-col border-t bg-card/30 divide-y divide-border/50">
          {bookmarks.map((b) => (
            <ArchivedBookmarkCard
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

function ArchivedBookmarkCard({
  bookmark,
  isNested,
  selected,
  onSelect,
}: {
  bookmark: BookmarkType;
  isNested?: boolean;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const restoreFromArchive = useBookmarksStore(s => s.restoreFromArchive);
  const trashBookmark = useBookmarksStore(s => s.trashBookmark);
  const tags = useWorkspaceStore(s => s.tags);
  const bookmarkTags = React.useMemo(
    () => tags.filter((tag) => bookmark.tags.includes(tag.id)),
    [tags, bookmark.tags]
  );

  function handleMoveToTrash() {
    restoreFromArchive(bookmark.id);
    setTimeout(() => trashBookmark(bookmark.id), 0);
  }

  return (
    <div
      className={cn(
        "group flex items-center gap-4 p-4 hover:bg-accent/50 transition-colors",
        !isNested && "rounded-lg border bg-card",
        onSelect && "cursor-pointer"
      )}
      onClick={() => onSelect?.()}
    >
      {onSelect && (
        <div
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-sm border border-primary transition-all cursor-pointer",
            selected ? "bg-primary text-primary-foreground" : "bg-transparent text-transparent"
          )}
          onClick={(e) => {
            e.stopPropagation();
            onSelect();
          }}
        >
          <Check className={cn("size-3", selected ? "opacity-100" : "opacity-0")} strokeWidth={3} />
        </div>
      )}
      <div className="size-10 rounded-lg bg-muted flex items-center justify-center overflow-hidden shrink-0">
        <FaviconImage
          src={bookmark.favicon}
          alt={bookmark.title}
          className="size-6"
          hasDarkIcon={bookmark.hasDarkIcon}
        />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="font-medium truncate">{bookmark.title}</h3>
          <TagList tags={bookmarkTags} max={2} className="hidden sm:flex" />
        </div>
        <p className="text-sm text-muted-foreground truncate">{bookmark.url}</p>
      </div>

      <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
        <Button variant="outline" size="sm" onClick={() => restoreFromArchive(bookmark.id)}>
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
              onClick={handleMoveToTrash}
            >
              <Trash2 className="size-4 mr-2" />
              Move to Trash
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

export function ArchiveContent() {
  const archivedBookmarks = useBookmarksStore(s => s.archivedBookmarks);
  const restoreFromArchive = useBookmarksStore(s => s.restoreFromArchive);
  const trashBookmark = useBookmarksStore(s => s.trashBookmark);
  const getArchivedCollections = useWorkspaceStore(s => s.getArchivedCollections);
  const restoreCollection = useWorkspaceStore(s => s.restoreCollection);
  const deleteCollection = useWorkspaceStore(s => s.deleteCollection);

  const archivedCollections = getArchivedCollections();
  const archivedCollectionIds = React.useMemo(
    () => new Set(archivedCollections.map(c => c.id)),
    [archivedCollections]
  );

  const collectionBookmarks = React.useMemo(() => {
    const map: Record<string, BookmarkType[]> = {};
    for (const b of archivedBookmarks) {
      if (archivedCollectionIds.has(b.collectionId)) {
        if (!map[b.collectionId]) map[b.collectionId] = [];
        map[b.collectionId].push(b);
      }
    }
    return map;
  }, [archivedBookmarks, archivedCollectionIds]);

  const individualArchivedBookmarks = React.useMemo(
    () => archivedBookmarks.filter(b => !archivedCollectionIds.has(b.collectionId)),
    [archivedBookmarks, archivedCollectionIds]
  );

  const totalCount = archivedCollections.length + individualArchivedBookmarks.length;

  const [selectedColIds, setSelectedColIds] = React.useState<Set<string>>(new Set());
  const [selectedBmIds, setSelectedBmIds] = React.useState<Set<string>>(new Set());
  const selectedCount = selectedColIds.size + selectedBmIds.size;

  const toggleCol = (id: string) => {
    setSelectedColIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleBm = (id: string) => {
    setSelectedBmIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selectedCount === totalCount) {
      setSelectedColIds(new Set());
      setSelectedBmIds(new Set());
    } else {
      setSelectedColIds(new Set(archivedCollections.map(c => c.id)));
      setSelectedBmIds(new Set(individualArchivedBookmarks.map(b => b.id)));
    }
  };

  const handleBatchRestore = () => {
    for (const colId of selectedColIds) {
      restoreCollection(colId);
    }
    for (const bmId of selectedBmIds) {
      restoreFromArchive(bmId);
    }
    setSelectedColIds(new Set());
    setSelectedBmIds(new Set());
  };

  const handleBatchDelete = () => {
    for (const colId of selectedColIds) {
      deleteCollection(colId);
    }
    const toTrash = Array.from(selectedBmIds);
    for (const bmId of toTrash) {
      restoreFromArchive(bmId);
    }
    for (const bmId of toTrash) {
      trashBookmark(bmId);
    }
    setSelectedColIds(new Set());
    setSelectedBmIds(new Set());
  };

  return (
    <div className="flex-1 w-full overflow-auto">
      <div className="p-4 md:p-6 space-y-6">
        <div className="flex items-center justify-between gap-4 p-4 rounded-xl border bg-card">
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-lg bg-violet-500/10 text-violet-500 flex items-center justify-center">
              <Archive className="size-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Archived</h2>
              <p className="text-sm text-muted-foreground">
                {archivedCollections.length > 0 && `${archivedCollections.length} collection${archivedCollections.length !== 1 ? "s" : ""}, `}
                {individualArchivedBookmarks.length} bookmark{individualArchivedBookmarks.length !== 1 ? "s" : ""}
              </p>
            </div>
          </div>

          {totalCount > 0 && selectedCount === 0 && (
            <Button variant="outline" size="sm" onClick={handleSelectAll}>
              Select All
            </Button>
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
                <Trash2 className="size-4 mr-1" /> Move to Trash
              </Button>
            </div>
          )}
        </div>

        {archivedCollections.length > 0 && (
          <div className="flex flex-col gap-2">
            {archivedCollections.map(col => (
              <ArchivedCollectionCard
                key={col.id}
                collection={col}
                bookmarks={collectionBookmarks[col.id] ?? []}
                selected={selectedColIds.has(col.id)}
                onSelect={() => toggleCol(col.id)}
                selectedBmIds={selectedBmIds}
                onToggleBm={toggleBm}
              />
            ))}
          </div>
        )}

        <div className="flex flex-col gap-2">
          {individualArchivedBookmarks.map((bookmark) => (
            <ArchivedBookmarkCard
              key={bookmark.id}
              bookmark={bookmark}
              selected={selectedBmIds.has(bookmark.id)}
              onSelect={() => toggleBm(bookmark.id)}
            />
          ))}
        </div>

        {totalCount === 0 && (
          <EmptyState
            icon={Archive}
            title="Archive is empty"
            description="Archived bookmarks and collections will appear here."
          />
        )}
      </div>
    </div>
  );
}
