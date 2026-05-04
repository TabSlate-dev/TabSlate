import { useMemo } from "react";
import { Bookmark, Star, Tag, FolderOpen, LucideIcon } from "lucide-react";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { cn } from "@/lib/utils";

interface StatBoxProps {
  label: string;
  value: number | string;
  icon: LucideIcon;
  theme: "blue" | "amber" | "violet" | "emerald";
}

function StatBox({ label, value, icon: Icon, theme }: StatBoxProps) {
  const themes = {
    blue: { text: "text-blue-500", bg: "bg-blue-500/10" },
    amber: { text: "text-amber-500", bg: "bg-amber-500/10" },
    violet: { text: "text-violet-500", bg: "bg-violet-500/10" },
    emerald: { text: "text-emerald-500", bg: "bg-emerald-500/10" }
  };

  const current = themes[theme];

  return (
    <div className="flex flex-col p-3 rounded-xl border border-transparent bg-muted/20 hover:bg-muted/50 transition-colors">
      <div className={cn("size-6 rounded-md flex items-center justify-center mb-2", current.bg)}>
        <Icon className={cn("size-3.5", current.text)} />
      </div>
      <span className="text-lg font-semibold tracking-tight text-foreground leading-none">{value}</span>
      <span className="text-[11px] font-medium text-muted-foreground mt-1">{label}</span>
    </div>
  );
}

export function StatsCards() {
  const bookmarks = useBookmarksStore(s => s.bookmarks);
  const collections = useWorkspaceStore(s => s.collections);
  const tags = useWorkspaceStore(s => s.tags);
  const activeWorkspaceId = useWorkspaceStore(s => s.activeWorkspaceId);

  const values = useMemo(() => {
    const wsCollectionIds = new Set(
      collections
        .filter((c) => c.workspaceId === activeWorkspaceId)
        .map((c) => c.id)
    );
    const wsBookmarks = bookmarks.filter((b) => wsCollectionIds.has(b.collectionId));
    return {
      bookmarks: wsBookmarks.length,
      favorites: wsBookmarks.filter((b) => b.isFavorite).length,
      collections: wsCollectionIds.size,
      tags: tags.length,
    };
  }, [bookmarks, collections, tags, activeWorkspaceId]);

  return (
    <div className="grid grid-cols-2 gap-2 px-3 py-2">
      <StatBox label="Bookmarks" value={values.bookmarks} icon={Bookmark} theme="blue" />
      <StatBox label="Favorites" value={values.favorites} icon={Star} theme="amber" />
      <StatBox label="Collections" value={values.collections} icon={FolderOpen} theme="violet" />
      <StatBox label="Tags" value={values.tags} icon={Tag} theme="emerald" />
    </div>
  );
}
