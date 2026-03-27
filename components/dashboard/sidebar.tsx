import * as React from "react";
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
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
  Palette,
  Plus,
  Search,
  Sparkles,
  Star,
  Tag,
  Archive,
  Trash2,
  Monitor,
  Layers,
  Trash,
  Wrench,
} from "lucide-react";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useGroupsStore } from "@/store/groups-store";
import { useWorkspaceStore, COLLECTION_ICONS, TAG_COLORS } from "@/store/workspace-store";
import { TAB_GROUP_COLORS } from "@/lib/chrome/tab-groups";
import type { Collection } from "@/lib/types";

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
  { icon: Monitor, label: "Open Tabs", href: "/tabs" },
  { icon: Layers, label: "Groups", href: "/groups" },
  { icon: Heart, label: "Favorites", href: "/favorites" },
  { icon: Archive, label: "Archive", href: "/archive" },
  { icon: Trash2, label: "Trash", href: "/trash" },
];

// ---------------------------------------------------------------------------
// CollectionDialog
// ---------------------------------------------------------------------------

interface CollectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: Collection;
  onSubmit: (name: string, icon: string) => void;
}

function CollectionDialog({
  open,
  onOpenChange,
  initial,
  onSubmit,
}: CollectionDialogProps) {
  const [name, setName] = React.useState(initial?.name ?? "");
  const [icon, setIcon] = React.useState(initial?.icon ?? "folder");

  React.useEffect(() => {
    if (open) {
      setName(initial?.name ?? "");
      setIcon(initial?.icon ?? "folder");
    }
  }, [open, initial]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSubmit(name.trim(), icon);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>
            {initial ? "Edit Collection" : "New Collection"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-1">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Collection"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Icon</label>
            <div className="flex flex-wrap gap-1.5">
              {COLLECTION_ICONS.map((ic) => {
                const Icon = ICON_MAP[ic] ?? Folder;
                return (
                  <button
                    key={ic}
                    type="button"
                    onClick={() => setIcon(ic)}
                    className={cn(
                      "size-8 rounded-md flex items-center justify-center transition-colors",
                      icon === ic
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted hover:bg-muted/80 text-muted-foreground"
                    )}
                  >
                    <Icon className="size-4" />
                  </button>
                );
              })}
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!name.trim()}>
              {initial ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// TagDialog
// ---------------------------------------------------------------------------

interface TagDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (name: string, color: string) => void;
}

function TagDialog({ open, onOpenChange, onSubmit }: TagDialogProps) {
  const [name, setName] = React.useState("");
  const [color, setColor] = React.useState<string>(TAG_COLORS[0]);

  React.useEffect(() => {
    if (open) {
      setName("");
      setColor(TAG_COLORS[0]);
    }
  }, [open]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSubmit(name.trim(), color);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>New Tag</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-1">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Tag name"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Color</label>
            <div className="flex flex-wrap gap-1.5">
              {TAG_COLORS.map((c) => {
                const bgColor = c.split(" ")[0];
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    className={cn(
                      "size-7 rounded-full transition-all",
                      bgColor.replace("/10", ""),
                      color === c
                        ? "ring-2 ring-primary ring-offset-2"
                        : "opacity-50 hover:opacity-100"
                    )}
                  />
                );
              })}
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!name.trim()}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// BookmarksSidebar
// ---------------------------------------------------------------------------

export function BookmarksSidebar({
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  const { pathname } = useLocation();
  const [collectionsOpen, setCollectionsOpen] = React.useState(true);
  const [groupsOpen, setGroupsOpen] = React.useState(true);
  const [tagsOpen, setTagsOpen] = React.useState(false);
  const [newCollectionOpen, setNewCollectionOpen] = React.useState(false);
  const [newTagOpen, setNewTagOpen] = React.useState(false);

  const { groups, deleteGroup } = useGroupsStore();
  const {
    selectedCollection,
    setSelectedCollection,
    selectedTags,
    toggleTag,
    clearTags,
    bookmarks,
  } = useBookmarksStore();
  const {
    collections,
    tags,
    activeWorkspaceId,
    createCollection,
    deleteCollection,
    createTag,
    deleteTag,
  } = useWorkspaceStore();

  const isHomePage = pathname === "/";

  // Collections for the active workspace
  const workspaceCollections = collections
    .filter((c) => c.workspaceId === activeWorkspaceId)
    .sort((a, b) => a.position - b.position);

  // Compute bookmark count per collection
  function countFor(collectionId: string): number {
    if (collectionId === "all") {
      const wsIds = new Set(workspaceCollections.map((c) => c.id));
      return bookmarks.filter((b) => wsIds.has(b.collectionId)).length;
    }
    return bookmarks.filter((b) => b.collectionId === collectionId).length;
  }

  return (
    <>
      <Sidebar collapsible="offcanvas" {...props}>
        <SidebarHeader className="px-4 pt-4 pb-0">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder="Search..."
              className="pl-9 h-9 bg-background text-sm"
            />
          </div>
        </SidebarHeader>

        <SidebarContent className="px-3 pt-3">
          {/* Collections */}
          <SidebarGroup className="p-0">
            <SidebarGroupLabel className="flex items-center gap-1.5 px-1 text-[10px] font-semibold tracking-wider text-muted-foreground">
              <button
                onClick={() => setCollectionsOpen(!collectionsOpen)}
                className="flex items-center gap-1.5 cursor-pointer"
              >
                <ChevronDown
                  className={cn(
                    "size-3.5 transition-transform",
                    !collectionsOpen && "-rotate-90"
                  )}
                />
                COLLECTIONS
              </button>
              <button
                onClick={() => setNewCollectionOpen(true)}
                className="ml-auto text-muted-foreground hover:text-foreground transition-colors"
              >
                <Plus className="size-3.5" />
              </button>
            </SidebarGroupLabel>

            {collectionsOpen && (
              <SidebarGroupContent>
                <SidebarMenu className="mt-1">
                  {/* "All" virtual collection */}
                  {(() => {
                    const isActive = isHomePage && selectedCollection === "all";
                    return (
                      <SidebarMenuItem key="all">
                        <SidebarMenuButton
                          asChild
                          isActive={isActive}
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
                            <span className="text-muted-foreground text-xs">
                              {countFor("all")}
                            </span>
                            {isActive && (
                              <ChevronRight className="size-3.5 text-muted-foreground opacity-60" />
                            )}
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })()}

                  {workspaceCollections.map((col) => {
                    const isActive =
                      isHomePage && selectedCollection === col.id;
                    return (
                      <SidebarMenuItem key={col.id}>
                        <SidebarMenuButton
                          asChild
                          isActive={isActive}
                          className="h-9 group/col"
                        >
                          <Link
                            to="/"
                            onClick={() => {
                              setSelectedCollection(col.id);
                              clearTags();
                            }}
                          >
                            <CollectionIcon icon={col.icon} />
                            <span className="flex-1 text-sm">{col.name}</span>
                            <span className="text-muted-foreground text-xs">
                              {countFor(col.id)}
                            </span>
                            {!col.isDefault && (
                              <button
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  deleteCollection(col.id);
                                }}
                                className="opacity-0 group-hover/col:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                              >
                                <Trash className="size-3" />
                              </button>
                            )}
                            {isActive && col.isDefault && (
                              <ChevronRight className="size-3.5 text-muted-foreground opacity-60" />
                            )}
                            {isActive && !col.isDefault && (
                              <ChevronRight className="size-3.5 text-muted-foreground opacity-60 group-hover/col:hidden" />
                            )}
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            )}
          </SidebarGroup>

          {/* Groups */}
          <SidebarGroup className="p-0">
            <SidebarGroupLabel className="flex items-center gap-1.5 px-1 text-[10px] font-semibold tracking-wider text-muted-foreground">
              <button
                onClick={() => setGroupsOpen(!groupsOpen)}
                className="flex items-center gap-1.5 cursor-pointer"
              >
                <ChevronDown
                  className={cn(
                    "size-3.5 transition-transform",
                    !groupsOpen && "-rotate-90"
                  )}
                />
                GROUPS
              </button>
              <Link
                to="/groups"
                className="ml-auto text-[10px] text-muted-foreground hover:text-foreground"
              >
                Manage
              </Link>
            </SidebarGroupLabel>
            {groupsOpen && (
              <SidebarGroupContent>
                <SidebarMenu className="mt-1">
                  {groups.length === 0 && (
                    <p className="text-xs text-muted-foreground px-1 py-1">
                      No saved groups
                    </p>
                  )}
                  {groups.map((group) => (
                    <SidebarMenuItem key={group.id}>
                      <SidebarMenuButton
                        asChild
                        isActive={pathname === "/groups"}
                        className="h-9 group/groupitem"
                      >
                        <Link to="/groups">
                          <span
                            className="size-2.5 rounded-full shrink-0"
                            style={{
                              backgroundColor: TAB_GROUP_COLORS[group.color],
                            }}
                          />
                          <span className="flex-1 truncate text-sm">
                            {group.name}
                          </span>
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
                </SidebarMenu>
              </SidebarGroupContent>
            )}
          </SidebarGroup>

          {/* Tags */}
          <SidebarGroup className="p-0">
            <SidebarGroupLabel className="flex items-center gap-1.5 px-1 text-[10px] font-semibold tracking-wider text-muted-foreground">
              <button
                onClick={() => setTagsOpen(!tagsOpen)}
                className="flex items-center gap-1.5 cursor-pointer"
              >
                <ChevronDown
                  className={cn(
                    "size-3.5 transition-transform",
                    !tagsOpen && "-rotate-90"
                  )}
                />
                TAGS
              </button>
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
            </SidebarGroupLabel>
            {tagsOpen && (
              <SidebarGroupContent>
                <div className="flex flex-wrap gap-1.5 mt-2 px-1">
                  {tags.length === 0 && (
                    <p className="text-xs text-muted-foreground w-full py-1">
                      No tags yet
                    </p>
                  )}
                  {tags.map((tag) => (
                    <button
                      key={tag.id}
                      onClick={() => toggleTag(tag.id)}
                      className={cn(
                        "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium transition-colors group/tag",
                        selectedTags.includes(tag.id)
                          ? "bg-primary text-primary-foreground"
                          : tag.color
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
                    <SidebarMenuButton
                      asChild
                      isActive={pathname === item.href}
                      className="h-9"
                    >
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
        </SidebarContent>

        <SidebarFooter className="px-4 pb-4" />
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
    </>
  );
}
