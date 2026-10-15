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
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  Bookmark,
  ChevronRight,
  Heart,
  Monitor,
  Plus,
  Search,
  Archive,
  Trash2,
  Trash,
} from "lucide-react";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useGroupsStore } from "@/store/groups-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { TAB_GROUP_COLORS } from "@/lib/chrome/tab-groups";
import type { Collection } from "@/lib/types";
import { CollectionDialog } from "./collection-dialog";
import { SidebarCollectionRow } from "./collection-row";
import { SidebarTagsSection } from "./tags-section";
import { SectionHeader } from "./section-header";
import { GroupDialog } from "./group-dialog";
import { SyncStatusIndicator } from "./sync-status";
import type { SyncStatus } from "@/lib/sync-engine";
import { QuotaCard } from "./quota-card";
import { UserProfile } from "./user-profile";
import { useTranslation } from "@/hooks/use-translation";
import { AuthDialog } from "@/components/auth/auth-dialog";
import type { AuthEntryMode } from "@/lib/auth-session";
import { useAuthStore } from "@/store/auth-store";
import { getActiveWorkspaceCollections, isActiveWorkspace } from "@/lib/workspace-visibility";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle } from "lucide-react";

const navItems = [
  { icon: Monitor, labelKey: "sidebar_navOpenTabs", href: "/tabs" },
  { icon: Heart, labelKey: "sidebar_navFavorites", href: "/favorites" },
  { icon: Archive, labelKey: "sidebar_navArchive", href: "/archive" },
  { icon: Trash2, labelKey: "sidebar_navTrash", href: "/trash" },
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
  syncErrorMessage?: string | null;
  onForceSync: () => void;
}

export function BookmarksSidebar({ syncStatus, syncErrorMessage, onForceSync, ...props }: BookmarksSidebarProps) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const [collectionsOpen, setCollectionsOpen] = React.useState(true);
  const [groupsOpen, setGroupsOpen] = React.useState(true);
  const [newCollectionOpen, setNewCollectionOpen] = React.useState(false);
  const [newGroupOpen, setNewGroupOpen] = React.useState(false);
  const [authDialogOpen, setAuthDialogOpen] = React.useState(false);
  const [authEntryMode, setAuthEntryMode] = React.useState<AuthEntryMode>("login");

  const accessToken = useAuthStore((s) => s.accessToken);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const isGuest = accessToken === null && refreshToken === null;

  // Fine-grained selectors — each value has its own subscription
  const selectedCollection = useBookmarksStore(s => s.selectedCollection);
  const setSelectedCollection = useBookmarksStore(s => s.setSelectedCollection);
  const clearTags = useBookmarksStore(s => s.clearTags);
  const countsByCollection = useBookmarksStore(s => s.countsByCollection);

  const allGroups = useGroupsStore(s => s.groups);
  const deleteGroup = useGroupsStore(s => s.deleteGroup);

  const collections = useWorkspaceStore(s => s.collections);
  const workspaces = useWorkspaceStore(s => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore(s => s.activeWorkspaceId);

  const groups = React.useMemo(
    () => {
      const activeWorkspace = workspaces.find(
        (workspace) => workspace.id === activeWorkspaceId,
      );
      return isActiveWorkspace(activeWorkspace)
        ? allGroups.filter(g => !g.deletedAt && g.workspaceId === activeWorkspaceId)
        : [];
    },
    [allGroups, activeWorkspaceId, workspaces]
  );
  const createCollection = useWorkspaceStore(s => s.createCollection);
  const highlightedCollectionIds = useWorkspaceStore(s => s.highlightedCollectionIds);

  const isHomePage = pathname === "/";
  const [targetUnavailable, setTargetUnavailable] = React.useState(false);

  // Memoize workspace collections to avoid re-filtering on every render
  const workspaceCollections = React.useMemo(
    () =>
      getActiveWorkspaceCollections(activeWorkspaceId, workspaces, collections),
    [activeWorkspaceId, workspaces, collections]
  );

  // Memoize per-collection bookmark counts
  const bookmarkCounts = React.useMemo(() => {
    const wsIds = new Set(workspaceCollections.map((c) => c.id));
    let total = 0;
    for (const [colId, n] of Object.entries(countsByCollection)) {
      if (wsIds.has(colId) || colId === "") {
        total += n;
      }
    }
    const perCol: Record<string, number> = { all: total };
    for (const collection of workspaceCollections) {
      perCol[collection.id] = countsByCollection[collection.id] ?? 0;
    }
    return perCol;
  }, [countsByCollection, workspaceCollections]);

  const handleSelectCollection = React.useCallback((collectionId: string) => {
    setSelectedCollection(collectionId);
    clearTags();
  }, [setSelectedCollection, clearTags]);

  const handleToggleCollections = React.useCallback(() => setCollectionsOpen(v => !v), []);
  const handleToggleGroups = React.useCallback(() => setGroupsOpen(v => !v), []);
  const handleOpenLogin = React.useCallback(() => {
    setAuthEntryMode("login");
    setAuthDialogOpen(true);
  }, []);
  const handleOpenRegistration = React.useCallback(() => {
    setAuthEntryMode("register");
    setAuthDialogOpen(true);
  }, []);

  return (
    <>
      {targetUnavailable && (
        <Alert className="fixed top-4 left-1/2 -translate-x-1/2 z-100 w-auto shadow-lg" variant="destructive">
          <AlertCircle />
          <AlertDescription>{t("workspaceVisibility_targetUnavailable")}</AlertDescription>
        </Alert>
      )}
      <Sidebar collapsible="offcanvas" {...props}>
        <SidebarHeader className="p-0">
          <UserProfile onLogin={handleOpenLogin} />
        </SidebarHeader>


        <SidebarContent className={cn("px-3 pt-3", isGuest ? "pb-24" : "pb-72")}>
          {/* Collections */}
          <SidebarGroup className="p-0">
            <SectionHeader
              label={t("sidebar_collections")}
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
                          <span className="flex-1 text-sm">{t("sidebar_allBookmarks")}</span>
                          <span className="text-muted-foreground text-xs">{bookmarkCounts.all ?? 0}</span>
                          {isHomePage && selectedCollection === "all" && (
                            <ChevronRight className="size-3.5 text-muted-foreground opacity-60" />
                          )}
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </DroppableZone>

                  {workspaceCollections.map((col) => (
                    <DroppableZone key={col.id} id={`sidebar-collection-${col.id}`}>
                      <SidebarCollectionRow
                        collection={col}
                        count={bookmarkCounts[col.id] ?? 0}
                        isActive={isHomePage && selectedCollection === col.id}
                        isHighlighted={highlightedCollectionIds.includes(col.id)}
                        onSelect={handleSelectCollection}
                      />
                    </DroppableZone>
                  ))}

                  <AddItemButton label={t("sidebar_addCollection")} onClick={() => setNewCollectionOpen(true)} />
                </SidebarMenu>
              </SidebarGroupContent>
            )}
          </SidebarGroup>

          {/* Groups */}
          <SidebarGroup className="p-0">
            <SectionHeader
              label={t("sidebar_groups")}
              open={groupsOpen}
              onToggle={handleToggleGroups}
            />

            {groupsOpen && (
              <SidebarGroupContent>
                <DroppableZone id="sidebar-groups">
                  <SidebarMenu className="mt-1">
                    {groups.length === 0 && (
                      <p className="text-xs text-muted-foreground px-1 py-1">{t("sidebar_noSavedGroups")}</p>
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

                    <AddItemButton label={t("sidebar_addGroup")} onClick={() => setNewGroupOpen(true)} />
                  </SidebarMenu>
                </DroppableZone>
              </SidebarGroupContent>
            )}
          </SidebarGroup>

          {/* Tags */}
          <SidebarTagsSection />

          {/* Nav */}
          <SidebarGroup className="p-0 mt-1">
            <SidebarGroupContent>
              <SidebarMenu>
                {navItems.map((item) => (
                  <SidebarMenuItem key={item.labelKey}>
                    <SidebarMenuButton asChild isActive={pathname === item.href} className="h-9">
                      <Link to={item.href}>
                        <item.icon className="size-4" />
                        <span className="text-sm">{t(item.labelKey)}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

        </SidebarContent>

        {/* Floating Quota Card & Sync Status Indicator Overlay */}
        <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-[var(--sidebar)] via-[var(--sidebar)]/98 to-transparent pt-16 pb-4 z-20 pointer-events-none flex flex-col gap-3.5">
          {!isGuest && (
            <div className="pointer-events-auto">
              <QuotaCard />
            </div>
          )}
          <div className="pointer-events-auto px-2">
            <SyncStatusIndicator
              status={syncStatus}
              errorMessage={syncErrorMessage}
              onForceSync={onForceSync}
              isGuest={isGuest}
              onRegister={handleOpenRegistration}
            />
          </div>
        </div>
      </Sidebar>

      {/* Dialogs (rendered outside Sidebar to avoid z-index issues) */}
      <CollectionDialog
        open={newCollectionOpen}
        onOpenChange={setNewCollectionOpen}
        onSubmit={(name, icon) => {
          const state = useWorkspaceStore.getState();
          const activeWorkspace = state.workspaces.find(
            (workspace) => workspace.id === state.activeWorkspaceId,
          );
          if (!isActiveWorkspace(activeWorkspace)) {
            setTargetUnavailable(true);
            return;
          }
          createCollection(state.activeWorkspaceId, name, icon);
          setTargetUnavailable(false);
          setNewCollectionOpen(false);
        }}
      />

      <GroupDialog
        open={newGroupOpen}
        onOpenChange={setNewGroupOpen}
        onSubmit={(name, color, selectedTabs, isCompact) => {
          const { createGroup, addTabToGroup } = useGroupsStore.getState();
          const state = useWorkspaceStore.getState();
          const activeWorkspace = state.workspaces.find(
            (workspace) => workspace.id === state.activeWorkspaceId,
          );
          if (!isActiveWorkspace(activeWorkspace)) {
            setTargetUnavailable(true);
            return;
          }
          const groupId = createGroup(name, color, isCompact, state.activeWorkspaceId);
          selectedTabs.forEach((tab) => {
            addTabToGroup(groupId, {
              title: tab.title,
              url: tab.url,
              favicon: tab.favIconUrl || "",
            });
          });
          setNewGroupOpen(false);
          setTargetUnavailable(false);
        }}
      />

      <AuthDialog
        open={authDialogOpen}
        initialMode={authEntryMode}
        onOpenChange={setAuthDialogOpen}
      />
    </>
  );
}
