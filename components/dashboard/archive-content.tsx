import * as React from "react";
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

function ArchivedCollectionCard({ collection, bookmarkCount }: { collection: Collection; bookmarkCount: number }) {
  const restoreCollection = useWorkspaceStore(s => s.restoreCollection);

  return (
    <div className="flex items-center gap-4 p-4 rounded-lg border bg-card hover:bg-accent/50 transition-colors">
      <div className="size-10 rounded-lg bg-muted flex items-center justify-center shrink-0">
        <CollectionIcon icon={collection.icon} className="size-5 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="font-medium truncate">{collection.name}</h3>
        <p className="text-sm text-muted-foreground">
          {bookmarkCount} bookmark{bookmarkCount !== 1 ? "s" : ""}
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={() => restoreCollection(collection.id)}>
        <RotateCcw className="size-4 mr-1" />
        Restore
      </Button>
    </div>
  );
}

function ArchivedBookmarkCard({ bookmark }: { bookmark: BookmarkType }) {
  const restoreFromArchive = useBookmarksStore(s => s.restoreFromArchive);
  const trashBookmark = useBookmarksStore(s => s.trashBookmark);
  const tags = useWorkspaceStore(s => s.tags);
  const bookmarkTags = React.useMemo(
    () => tags.filter((tag) => bookmark.tags.includes(tag.id)),
    [tags, bookmark.tags]
  );

  return (
    <div className="group flex items-center gap-4 p-4 rounded-lg border bg-card hover:bg-accent/50 transition-colors">
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

      <div className="flex items-center gap-1">
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
              onClick={() => {
                restoreFromArchive(bookmark.id);
                setTimeout(() => trashBookmark(bookmark.id), 0);
              }}
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
  const getArchivedCollections = useWorkspaceStore(s => s.getArchivedCollections);

  const archivedCollections = getArchivedCollections();
  const archivedCollectionIds = React.useMemo(
    () => new Set(archivedCollections.map(c => c.id)),
    [archivedCollections]
  );

  const collectionBookmarkCounts = React.useMemo(() => {
    const counts: Record<string, number> = {};
    for (const b of archivedBookmarks) {
      if (archivedCollectionIds.has(b.collectionId)) {
        counts[b.collectionId] = (counts[b.collectionId] ?? 0) + 1;
      }
    }
    return counts;
  }, [archivedBookmarks, archivedCollectionIds]);

  const individualArchivedBookmarks = React.useMemo(
    () => archivedBookmarks.filter(b => !archivedCollectionIds.has(b.collectionId)),
    [archivedBookmarks, archivedCollectionIds]
  );

  const totalCount = archivedCollections.length + individualArchivedBookmarks.length;

  return (
    <div className="flex-1 w-full overflow-auto">
      <div className="p-4 md:p-6 space-y-6">
        <div className="flex items-center gap-3 p-4 rounded-xl border bg-card">
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

        {archivedCollections.length > 0 && (
          <div className="flex flex-col gap-2">
            {archivedCollections.map(col => (
              <ArchivedCollectionCard
                key={col.id}
                collection={col}
                bookmarkCount={collectionBookmarkCounts[col.id] ?? 0}
              />
            ))}
          </div>
        )}

        <div className="flex flex-col gap-2">
          {individualArchivedBookmarks.map((bookmark) => (
            <ArchivedBookmarkCard key={bookmark.id} bookmark={bookmark} />
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
