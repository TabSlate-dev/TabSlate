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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
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
  Trash,
  Wrench,
  FolderPlus,
} from "lucide-react";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useGroupsStore } from "@/store/groups-store";
import { useWorkspaceStore, COLLECTION_ICONS, TAG_COLORS } from "@/store/workspace-store";
import { useTabsStore } from "@/store/tabs-store";
import { TAB_GROUP_COLORS, TAB_GROUP_COLOR_KEYS, type TabGroupColor } from "@/lib/chrome/tab-groups";
import { TabRow } from "./tab-row";
import type { BrowserTab } from "@/lib/chrome/tabs";
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
  { icon: Monitor, label: "Open Tabs & Groups", href: "/tabs" },
  { icon: Heart, label: "Favorites", href: "/favorites" },
  { icon: Archive, label: "Archive", href: "/archive" },
  { icon: Trash2, label: "Trash", href: "/trash" },
] as const;

// ---------------------------------------------------------------------------
// DroppableZone — generic drop target wrapper (collections & groups section).
// Owns its DnD subscriptions so BookmarksSidebar never re-renders during drag.
// ---------------------------------------------------------------------------

function DroppableZone({ id, children }: { id: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const { activeData } = useTabsDndContext();
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "rounded-md",
        isOver && (activeData?.type === "tab-group" || activeData?.type === "tab") && "ring-1 ring-primary/40 bg-primary/5"
      )}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SectionHeader — collapsible section label with optional right-side actions.
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
// AddItemButton — dashed "add" button at the bottom of a sidebar section.
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
// CollectionDialog
// ---------------------------------------------------------------------------

interface CollectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: Collection;
  onSubmit: (name: string, icon: string) => void;
}

function CollectionDialog({ open, onOpenChange, initial, onSubmit }: CollectionDialogProps) {
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
          <DialogTitle>{initial ? "Edit Collection" : "New Collection"}</DialogTitle>
          <DialogDescription className="sr-only">
            {initial
              ? "Edit the name and icon of this collection."
              : "Create a new collection to organize your bookmarks."}
          </DialogDescription>
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
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
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
          <DialogDescription className="sr-only">
            Create a new tag to label your bookmarks.
          </DialogDescription>
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
                      color === c ? "ring-2 ring-primary ring-offset-2" : "opacity-50 hover:opacity-100"
                    )}
                  />
                );
              })}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
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
// GroupDialog
// ---------------------------------------------------------------------------

interface GroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (name: string, color: TabGroupColor, selectedTabs: BrowserTab[], compact: boolean) => void;
}

function GroupDialog({ open, onOpenChange, onSubmit }: GroupDialogProps) {
  const [name, setName] = React.useState("");
  const [color, setColor] = React.useState<TabGroupColor>("blue");
  const [selectedTabIds, setSelectedTabIds] = React.useState<Set<number>>(new Set());
  const [isCompact, setIsCompact] = React.useState(true);

  const { openTabs, loadTabs } = useTabsStore();

  React.useEffect(() => {
    if (open) {
      setName("");
      setColor("blue");
      setSelectedTabIds(new Set());
      setIsCompact(true);
      loadTabs();
    }
  }, [open, loadTabs]);

  const toggleTab = (id: number, checked: boolean) => {
    setSelectedTabIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedTabIds.size === 0) return;
    const selectedTabs = openTabs.filter((t) => selectedTabIds.has(t.id));
    onSubmit(name.trim(), color, selectedTabs, isCompact);
  };

  const allSelected = selectedTabIds.size === openTabs.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl max-h-[85vh] flex flex-col p-0 overflow-hidden gap-0 border-none shadow-2xl">
        <form onSubmit={handleSubmit} className="flex flex-col h-full max-h-[85vh]">
          <DialogHeader className="p-4 border-b shrink-0 bg-background/50 backdrop-blur-md">
            <DialogTitle className="flex items-center gap-2 text-xl font-bold">
              <FolderPlus className="size-5 text-primary" />
              New Saved Group
            </DialogTitle>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto p-4 space-y-6">
            <div className="space-y-4">
              <label className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                Group Details
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 bg-muted/20 p-4 rounded-2xl border border-border/50">
                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground ml-1">
                    Group Name
                  </label>
                  <Input
                    placeholder="e.g. Work, Social..."
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="h-9 focus-visible:ring-primary shadow-sm"
                    autoFocus
                  />
                </div>

                <div className="space-y-4">
                  <label className="text-xs font-medium text-muted-foreground ml-1">
                    Theme Color
                  </label>
                  <div className="flex gap-1.5 flex-1">
                    {TAB_GROUP_COLOR_KEYS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setColor(c as TabGroupColor)}
                        className={cn(
                          "size-5 rounded-full transition-all hover:scale-110 shrink-0",
                          color === c
                            ? "ring-2 ring-primary ring-offset-1 shadow-md"
                            : "opacity-40 hover:opacity-100"
                        )}
                        style={{ backgroundColor: TAB_GROUP_COLORS[c as TabGroupColor] }}
                      />
                    ))}
                  </div>
                </div>
              </div>

              <div className="flex justify-end pt-2">
                <div className="flex items-center gap-2 bg-muted/40 px-3 py-1.5 rounded-full border border-border/50">
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">
                    Compact Name
                  </span>
                  <Switch checked={isCompact} onCheckedChange={setIsCompact} className="scale-90" />
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between border-b pb-2">
                <label className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-3">
                  Select Tabs to Save
                  <span className="text-xs font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                    {selectedTabIds.size} / {openTabs.length}
                  </span>
                </label>
                {openTabs.length > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedTabIds(allSelected ? new Set() : new Set(openTabs.map((t) => t.id)))
                    }
                    className="text-xs font-semibold text-primary hover:text-primary/80 transition-all hover:underline"
                  >
                    {allSelected ? "Deselect All" : "Select All"}
                  </button>
                )}
              </div>

              {openTabs.length === 0 ? (
                <div className="py-20 text-center border-2 border-dashed rounded-2xl bg-muted/5">
                  <p className="text-sm text-muted-foreground">No open tabs found in current window.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pb-4">
                  {openTabs.map((tab) => (
                    <TabRow
                      key={tab.id}
                      tab={tab}
                      showCheckbox
                      selected={selectedTabIds.has(tab.id)}
                      onSelect={(checked) => toggleTab(tab.id, checked)}
                      hideActions
                      variant="card"
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          <DialogFooter className="p-4 border-t bg-muted/30 shrink-0 backdrop-blur-sm">
            <div className="flex items-center gap-3 w-full sm:justify-end">
              <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={selectedTabIds.size === 0}
                className="shadow-sm shadow-primary/10 transition-all hover:translate-y-[-1px] active:translate-y-[0px]"
              >
                Save Group
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// BookmarksSidebar
// ---------------------------------------------------------------------------

export function BookmarksSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { pathname } = useLocation();
  const [collectionsOpen, setCollectionsOpen] = React.useState(true);
  const [groupsOpen, setGroupsOpen] = React.useState(true);
  const [tagsOpen, setTagsOpen] = React.useState(false);
  const [newCollectionOpen, setNewCollectionOpen] = React.useState(false);
  const [newTagOpen, setNewTagOpen] = React.useState(false);
  const [newGroupOpen, setNewGroupOpen] = React.useState(false);

  const { selectedCollection, setSelectedCollection, selectedTags, toggleTag, clearTags, bookmarks } =
    useBookmarksStore();
  const { groups, deleteGroup } = useGroupsStore();
  const { collections, tags, activeWorkspaceId, createCollection, deleteCollection, createTag, deleteTag, highlightedCollectionIds } =
    useWorkspaceStore();

  const isHomePage = pathname === "/";

  const workspaceCollections = collections
    .filter((c) => c.workspaceId === activeWorkspaceId)
    .sort((a, b) => a.position - b.position);

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
            <Input placeholder="Search..." className="pl-9 h-9 bg-background text-sm" />
          </div>
        </SidebarHeader>

        <SidebarContent className="px-3 pt-3">
          {/* Collections */}
          <SidebarGroup className="p-0">
            <SectionHeader
              label="COLLECTIONS"
              open={collectionsOpen}
              onToggle={() => setCollectionsOpen((v) => !v)}
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
                  {/* "All" virtual collection */}
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
                          <span className="text-muted-foreground text-xs">{countFor("all")}</span>
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
                              <span className="flex-1 text-sm">{col.name}</span>
                              <span className="text-muted-foreground text-xs">{countFor(col.id)}</span>
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
                              {isActive && (
                                <ChevronRight
                                  className={cn(
                                    "size-3.5 text-muted-foreground opacity-60",
                                    !col.isDefault && "group-hover/col:hidden"
                                  )}
                                />
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
              onToggle={() => setGroupsOpen((v) => !v)}
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
                        <SidebarMenuButton asChild className="h-9 group/groupitem">
                          <div className="flex items-center gap-2 px-2 w-full">
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
                          </div>
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
              onToggle={() => setTagsOpen((v) => !v)}
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

      <GroupDialog
        open={newGroupOpen}
        onOpenChange={setNewGroupOpen}
        onSubmit={(name, color, selectedTabs) => {
          const { createGroup, addTabToGroup } = useGroupsStore.getState();
          const groupId = createGroup(name, color);
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
