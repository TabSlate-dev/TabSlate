import * as React from "react";
import { useDroppable } from "@dnd-kit/core";
import { useTabsDndContext } from "@/components/dashboard/tabs-dnd-provider";
import { Link, useLocation } from "react-router-dom";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  Bookmark,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Code,
  Folder,
  Globe,
  Heart,
  Inbox,
  Monitor,
  Palette,
  Plus,
  Search,
  Sparkles,
  Star,
  Tag,
  Archive,
  MoreHorizontal,
  Trash2,
  Trash,
  Wrench,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useGroupsStore } from "@/store/groups-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { TAB_GROUP_COLORS } from "@/lib/chrome/tab-groups";
import type { Collection } from "@/lib/types";
import { CollectionDialog } from "./collection-dialog";
import { TagDialog } from "./tag-dialog";
import { GroupDialog } from "./group-dialog";
import { SyncStatusIndicator } from "./sync-status";
import type { SyncStatus } from "@/lib/sync-engine";
import { StatsCards } from "../stats-cards";

// ---------------------------------------------------------------------------
// Icon map
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

function CollectionIcon({ icon }: { icon: string }) {
  const Icon = ICON_MAP[icon] ?? Folder;
  return <Icon className="size-4" />;
}

const navItems = [
  { icon: Monitor, label: "Open Tabs & Groups", href: "/tabs" },
  { icon: Heart, label: "Favorites", href: "/favorites" },
  { icon: Archive, label: "Archive", href: "/archive" },
  { icon: Trash2, label: "Trash", href: "/trash" },
] as const;

// ---------------------------------------------------------------------------
// DroppableZone — generic drop target wrapper.
// Owns its own DnD subscriptions so BookmarksSidebar never re-renders on drag.
// ---------------------------------------------------------------------------
function DroppableZone({ id, children }: { id: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const { activeData } = useTabsDndContext();

  const isAccepting = React.useMemo(() => {
    if (!activeData) { return false; }
    // Collection zones accept tabs, groups (to save all tabs), and bookmarks (to move/copy)
    if (id.startsWith("sidebar-collection-")) {
      return ["tab", "tab-group", "bookmark"].includes(activeData.type);
    }
    // Groups zone currently only accepts tab-groups to save them
    if (id === "sidebar-groups") {
      return activeData.type === "tab-group";
    }
    return false;
  }, [id, activeData]);

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "rounded-md transition-all duration-200",
        isOver && isAccepting && "ring-1 ring-primary/40 bg-primary/5"
      )}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SectionHeader
// ---------------------------------------------------------------------------
interface SectionHeaderProps {
  label: string;
  open: boolean;
  onToggle: () => void;
  actions?: React.ReactNode;
}

function SectionHeader({ label, open, onToggle, actions }: SectionHeaderProps) {
  return (
    <SidebarGroupLabel className="flex items-center gap-1.5 px-1 text-[10px] font-semibold tracking-wider text-muted-foreground">
      <button onClick={onToggle} className="flex items-center gap-1.5 cursor-pointer">
        <ChevronDown className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />
        {label}
      </button>
      {actions}
    </SidebarGroupLabel>
  );
}

// ---------------------------------------------------------------------------
// AddItemButton
// ---------------------------------------------------------------------------
function AddItemButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <SidebarMenuItem className="mt-2 px-1">
      <button
        onClick={onClick}
        className="w-full h-8 flex items-center justify-center gap-2 rounded-md border border-dashed border-muted-foreground/30 hover:border-muted-foreground/60 hover:bg-muted/50 text-muted-foreground transition-all group"
      >
        <Plus className="size-3.5 group-hover:scale-110 transition-transform" />
        <span className="text-xs font-medium">{label}</span>
      </button>
    </SidebarMenuItem>
  );
}

// ---------------------------------------------------------------------------
// BookmarksSidebar
// ---------------------------------------------------------------------------
interface BookmarksSidebarProps extends React.ComponentProps<typeof Sidebar> {
  syncStatus: SyncStatus;
  onForceSync: () => void;
}

export function BookmarksSidebar({ syncStatus, onForceSync, ...props }: BookmarksSidebarProps) {
  const { pathname } = useLocation();
  const [collectionsOpen, setCollectionsOpen] = React.useState(true);
  const [groupsOpen, setGroupsOpen] = React.useState(true);
  const [tagsOpen, setTagsOpen] = React.useState(false);
  const [newCollectionOpen, setNewCollectionOpen] = React.useState(false);
  const [newTagOpen, setNewTagOpen] = React.useState(false);
  const [newGroupOpen, setNewGroupOpen] = React.useState(false);

  // Fine-grained selectors — each value has its own subscription
  const selectedCollection = useBookmarksStore(s => s.selectedCollection);
  const setSelectedCollection = useBookmarksStore(s => s.setSelectedCollection);
  const selectedTags = useBookmarksStore(s => s.selectedTags);
  const toggleTag = useBookmarksStore(s => s.toggleTag);
  const clearTags = useBookmarksStore(s => s.clearTags);
  const bookmarks = useBookmarksStore(s => s.bookmarks);

  const groups = useGroupsStore(s => s.groups);
  const deleteGroup = useGroupsStore(s => s.deleteGroup);

  const collections = useWorkspaceStore(s => s.collections);
  const tags = useWorkspaceStore(s => s.tags);
  const activeWorkspaceId = useWorkspaceStore(s => s.activeWorkspaceId);
  const createCollection = useWorkspaceStore(s => s.createCollection);
  const deleteCollection = useWorkspaceStore(s => s.deleteCollection);
  const archiveCollection = useWorkspaceStore(s => s.archiveCollection);
  const createTag = useWorkspaceStore(s => s.createTag);
  const deleteTag = useWorkspaceStore(s => s.deleteTag);
  const highlightedCollectionIds = useWorkspaceStore(s => s.highlightedCollectionIds);

  const isHomePage = pathname === "/";

  // Memoize workspace collections to avoid re-filtering on every render
  const workspaceCollections = React.useMemo(
    () =>
      collections
        .filter((c) => c.workspaceId === activeWorkspaceId && !c.deletedAt && !c.archivedAt)
        .sort((a, b) => a.position - b.position),
    [collections, activeWorkspaceId]
  );

  // Memoize per-collection bookmark counts
  const bookmarkCounts = React.useMemo(() => {
    const wsIds = new Set(workspaceCollections.map((c) => c.id));
    const counts: Record<string, number> = { all: 0 };
    for (const b of bookmarks) {
      if (wsIds.has(b.collectionId)) {
        counts.all = (counts.all ?? 0) + 1;
        counts[b.collectionId] = (counts[b.collectionId] ?? 0) + 1;
      }
    }
    return counts;
  }, [bookmarks, workspaceCollections]);

  const handleToggleCollections = React.useCallback(() => setCollectionsOpen(v => !v), []);
  const handleToggleGroups = React.useCallback(() => setGroupsOpen(v => !v), []);
  const handleToggleTags = React.useCallback(() => setTagsOpen(v => !v), []);

  return (
    <>
      <Sidebar collapsible="offcanvas" {...props}>
        <SidebarHeader className="px-4 pt-4 pb-0">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input placeholder="Search..." className="pl-9 h-9 bg-background text-sm" />
          </div>
        </SidebarHeader>

        <SidebarContent className="px-3 pt-3">
          {/* Collections */}
          <SidebarGroup className="p-0">
            <SectionHeader
              label="COLLECTIONS"
              open={collectionsOpen}
              onToggle={handleToggleCollections}
              actions={
                <button
                  onClick={() => setNewCollectionOpen(true)}
                  className="ml-auto text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Plus className="size-3.5" />
                </button>
              }
            />

            {collectionsOpen && (
              <SidebarGroupContent>
                <SidebarMenu className="mt-1">
                  <DroppableZone id="sidebar-collection-all">
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        asChild
                        isActive={isHomePage && selectedCollection === "all"}
                        className="h-9"
                      >
                        <Link
                          to="/"
                          onClick={() => {
                            setSelectedCollection("all");
                            clearTags();
                          }}
                        >
                          <Bookmark className="size-4" />
                          <span className="flex-1 text-sm">All Bookmarks</span>
                          <span className="text-muted-foreground text-xs">{bookmarkCounts.all ?? 0}</span>
                          {isHomePage && selectedCollection === "all" && (
                            <ChevronRight className="size-3.5 text-muted-foreground opacity-60" />
                          )}
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </DroppableZone>

                  {workspaceCollections.map((col) => {
                    const isActive = isHomePage && selectedCollection === col.id;
                    const isHighlighted = highlightedCollectionIds.includes(col.id);
                    return (
                      <DroppableZone key={col.id} id={`sidebar-collection-${col.id}`}>
                        <SidebarMenuItem>
                          <SidebarMenuButton
                            asChild
                            isActive={isActive}
                            className={cn("h-9 group/col transition-all", isHighlighted && "ring-2 ring-inset ring-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-500")}
                          >
                            <Link
                              to="/"
                              onClick={() => {
                                setSelectedCollection(col.id);
                                clearTags();
                              }}
                            >
                              <CollectionIcon icon={col.icon} />
                              <span className="flex-1 text-sm truncate">{col.name}</span>
                              <div className="flex items-center">
                                {!col.isDefault && (
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <button
                                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                                        className="flex items-center justify-center overflow-hidden opacity-0 -translate-x-2 w-0 group-hover/col:w-4 group-hover/col:mr-1 group-hover/col:opacity-100 group-hover/col:translate-x-0 text-muted-foreground hover:text-foreground transition-all duration-300 ease-out"
                                      >
                                        <MoreHorizontal className="size-3 shrink-0" />
                                      </button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" side="right">
                                      <DropdownMenuItem
                                        onClick={(e) => { e.preventDefault(); archiveCollection(col.id); }}
                                      >
                                        <Archive className="size-4 mr-2" />
                                        Archive
                                      </DropdownMenuItem>
                                      <DropdownMenuSeparator />
                                      <DropdownMenuItem
                                        className="text-destructive focus:text-destructive"
                                        onClick={(e) => { e.preventDefault(); deleteCollection(col.id); }}
                                      >
                                        <Trash2 className="size-4 mr-2" />
                                        Delete
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                )}
                                <span className="text-muted-foreground text-xs shrink-0">{bookmarkCounts[col.id] ?? 0}</span>
                              </div>
                              {isActive && (
                                <ChevronRight className="size-3.5 text-muted-foreground opacity-60 shrink-0 ml-1" />
                              )}
                            </Link>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      </DroppableZone>
                    );
                  })}

                  <AddItemButton label="Add Collection" onClick={() => setNewCollectionOpen(true)} />
                </SidebarMenu>
              </SidebarGroupContent>
            )}
          </SidebarGroup>

          {/* Groups */}
          <SidebarGroup className="p-0">
            <SectionHeader
              label="GROUPS"
              open={groupsOpen}
              onToggle={handleToggleGroups}
            />

            {groupsOpen && (
              <SidebarGroupContent>
                <DroppableZone id="sidebar-groups">
                  <SidebarMenu className="mt-1">
                    {groups.length === 0 && (
                      <p className="text-xs text-muted-foreground px-1 py-1">No saved groups</p>
                    )}
                    {groups.map((group) => (
                      <SidebarMenuItem key={group.id}>
                        <SidebarMenuButton
                          asChild
                          isActive={pathname === `/groups/${group.id}`}
                          className="h-9 group/groupitem"
                        >
                          <Link to={`/groups/${group.id}`}>
                            <span
                              className="size-2.5 rounded-full shrink-0"
                              style={{ backgroundColor: TAB_GROUP_COLORS[group.color] }}
                            />
                            <span className="flex-1 truncate text-sm">{group.name}</span>
                            <button
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                deleteGroup(group.id);
                              }}
                              className="opacity-0 group-hover/groupitem:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                            >
                              <Trash className="size-3" />
                            </button>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}

                    <AddItemButton label="Add Group" onClick={() => setNewGroupOpen(true)} />
                  </SidebarMenu>
                </DroppableZone>
              </SidebarGroupContent>
            )}
          </SidebarGroup>

          {/* Tags */}
          <SidebarGroup className="p-0">
            <SectionHeader
              label="TAGS"
              open={tagsOpen}
              onToggle={handleToggleTags}
              actions={
                <div className="ml-auto flex items-center gap-1">
                  {selectedTags.length > 0 && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        clearTags();
                      }}
                      className="text-[10px] text-muted-foreground hover:text-foreground"
                    >
                      Clear
                    </button>
                  )}
                  <button
                    onClick={() => setNewTagOpen(true)}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Plus className="size-3.5" />
                  </button>
                </div>
              }
            />

            {tagsOpen && (
              <SidebarGroupContent>
                <div className="flex flex-wrap gap-1.5 mt-2 px-1">
                  {tags.length === 0 && (
                    <p className="text-xs text-muted-foreground w-full py-1">No tags yet</p>
                  )}
                  {tags.map((tag) => (
                    <button
                      key={tag.id}
                      onClick={() => toggleTag(tag.id)}
                      className={cn(
                        "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium transition-colors group/tag",
                        selectedTags.includes(tag.id) ? "bg-primary text-primary-foreground" : tag.color
                      )}
                    >
                      <Tag className="size-3" />
                      {tag.name}
                      <span
                        role="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteTag(tag.id);
                        }}
                        className="hidden group-hover/tag:inline ml-0.5 hover:opacity-70"
                      >
                        ×
                      </span>
                    </button>
                  ))}
                </div>
              </SidebarGroupContent>
            )}
          </SidebarGroup>

          {/* Nav */}
          <SidebarGroup className="p-0 mt-1">
            <SidebarGroupContent>
              <SidebarMenu>
                {navItems.map((item) => (
                  <SidebarMenuItem key={item.label}>
                    <SidebarMenuButton asChild isActive={pathname === item.href} className="h-9">
                      <Link to={item.href}>
                        <item.icon className="size-4" />
                        <span className="text-sm">{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          {/* Stats */}
          <div className="mt-auto pt-6 pb-2">
            <StatsCards />
          </div>
        </SidebarContent>

        <SidebarFooter className="px-4 pb-4">
          <SyncStatusIndicator status={syncStatus} onForceSync={onForceSync} />
        </SidebarFooter>
      </Sidebar>

      {/* Dialogs (rendered outside Sidebar to avoid z-index issues) */}
      <CollectionDialog
        open={newCollectionOpen}
        onOpenChange={setNewCollectionOpen}
        onSubmit={(name, icon) => {
          createCollection(activeWorkspaceId, name, icon);
          setNewCollectionOpen(false);
        }}
      />

      <TagDialog
        open={newTagOpen}
        onOpenChange={setNewTagOpen}
        onSubmit={(name, color) => {
          createTag(name, color);
          setNewTagOpen(false);
        }}
      />

      <GroupDialog
        open={newGroupOpen}
        onOpenChange={setNewGroupOpen}
        onSubmit={(name, color, selectedTabs, isCompact) => {
          const { createGroup, addTabToGroup } = useGroupsStore.getState();
          const groupId = createGroup(name, color, isCompact);
          selectedTabs.forEach((tab) => {
            addTabToGroup(groupId, {
              title: tab.title,
              url: tab.url,
              favicon: tab.favIconUrl || "",
            });
          });
          setNewGroupOpen(false);
        }}
      />
    </>
  );
}
