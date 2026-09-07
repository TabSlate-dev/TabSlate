import React, { createContext, useContext, useState } from "react";
import {
  DndContext,
  DragEndEvent,
  DragOverEvent,
  DragStartEvent,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  DragOverlay,
} from "@dnd-kit/core";
import type { CollisionDetection } from "@dnd-kit/core";
import { SmartPointerSensor } from "@/lib/drag-sensors";
import { useTabsStore } from "@/store/tabs-store";
import { useGroupsStore } from "@/store/groups-store";
import { bookmarksAsArray, useBookmarksStore } from "@/store/bookmarks-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { generateId } from "@/lib/id";
import { TAB_GROUP_COLOR_KEYS, type TabGroupColor } from "@/lib/chrome/tab-groups";
import { findDuplicateBookmark } from "@/lib/bookmark-utils";
import type { BrowserTab } from "@/lib/chrome/tabs";
import { TAB_GROUP_COLORS } from "@/lib/chrome/tab-groups";
import { FaviconImage } from "@/components/ui/favicon-image";
import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { BookmarkCard } from "@/components/dashboard/bookmark-card";
import {
  getActiveWorkspaceCollectionIds,
  getActiveWorkspaceCollections,
  isActiveWorkspace,
  resolveActiveWorkspaceCollectionTarget,
} from "@/lib/workspace-visibility";
import {
  isCollectionDropId,
  isSavedGroupDropId,
  parseCollectionDropId,
  parseSavedGroupDropId,
} from "@/lib/drop-ids";
import { useTranslation } from "@/hooks/use-translation";

export type TabDragData = {
  type: "tab";
  tabId: number;
  fromGroupId: number; // -1 if ungrouped
  title: string;
  url: string;
  favIconUrl: string;
};

export type TabGroupDragData = {
  type: "tab-group";
  groupId: number;
  groupName: string;
  groupColor: TabGroupColor;
  tabs: BrowserTab[];
};

export type BookmarkDragData = {
  type: "bookmark";
  bookmarkId: string;
  title: string;
  url: string;
  favicon: string;
  variant: "grid" | "list";
};

export type DragData = TabDragData | TabGroupDragData | BookmarkDragData;

interface TabsDndContextValue {
  activeData: DragData | null;
  /**
   * Collection currently under the cursor, or null.
   *
   * A Collection spans several droppable rows in the virtualized content list,
   * so per-row `isOver` would light up only the row under the cursor. Sharing
   * the hovered Collection lets its header and every one of its rows highlight
   * together as one band.
   */
  overCollectionId: string | null;
}

const TabsDndCtx = createContext<TabsDndContextValue>({
  activeData: null,
  overCollectionId: null,
});

export function useTabsDndContext() {
  return useContext(TabsDndCtx);
}

/**
 * Drop on whatever is under the cursor.
 *
 * dnd-kit's default `rectIntersection` ranks by intersection-over-union, which
 * penalises large drop zones: a full-width Collection row loses to the much
 * smaller Collection header sitting next to it, so only headers ever won. The
 * rect pass is kept as a fallback for the moment the pointer leaves every zone
 * mid-drag.
 */
const collisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  return pointerCollisions.length > 0 ? pointerCollisions : rectIntersection(args);
};

export function TabsDndProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [activeData, setActiveData] = useState<DragData | null>(null);
  const [overCollectionId, setOverCollectionId] = useState<string | null>(null);
  const [notification, setNotification] = useState<{ text: string; type: "duplicate" } | null>(null);

  const sensors = useSensors(
    useSensor(SmartPointerSensor, { activationConstraint: { delay: 250, tolerance: 5 } })
  );

  const showNotification = (text: string, durationMs = 3000) => {
    setNotification({ text, type: "duplicate" });
    setTimeout(() => setNotification(null), durationMs);
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveData((event.active.data.current as DragData) ?? null);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const dropId = event.over?.id;
    setOverCollectionId(
      typeof dropId === "string" && isCollectionDropId(dropId)
        ? parseCollectionDropId(dropId)
        : null
    );
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveData(null);
    setOverCollectionId(null);
    const { active, over } = event;

    const dragData = active.data.current as DragData | undefined;
    if (!dragData) { return; }

    // Tab dropped on empty space → ungroup if it was in a group
    if (!over) {
      if (dragData.type === "tab" && dragData.fromGroupId !== -1) {
        useTabsStore.getState().ungroupSpecificTabs([dragData.tabId]);
      }
      return;
    }

    const dropId = over.id as string;

    const handleDropToCollection = (
      collectionDropId: string,
      tabsToDrop: { id: number; title: string; url: string; favIconUrl: string }[]
    ) => {
      const collectionId = parseCollectionDropId(collectionDropId);
      const workspaceState = useWorkspaceStore.getState();
      const activeWorkspace = workspaceState.workspaces.find(
        (workspace) => workspace.id === workspaceState.activeWorkspaceId,
      );
      if (!isActiveWorkspace(activeWorkspace)) {
        showNotification(t("workspaceVisibility_targetUnavailable"));
        return;
      }
      let targetCollectionId = collectionId;
      if (collectionId === "all") {
        const activeCollections = getActiveWorkspaceCollections(
          workspaceState.activeWorkspaceId,
          workspaceState.workspaces,
          workspaceState.collections,
        );
        const defaultCol = activeCollections.find((candidate) => candidate.isDefault);
        targetCollectionId = defaultCol?.id || "";
      }

      const target = resolveActiveWorkspaceCollectionTarget(
        targetCollectionId,
        workspaceState.activeWorkspaceId,
        workspaceState.workspaces,
        workspaceState.collections,
      );
      if (!target) {
        showNotification(t("workspaceVisibility_targetUnavailable"));
        return;
      }

      if (target.id) {
        const now = new Date().toISOString();
        const activeCollectionIds = getActiveWorkspaceCollectionIds(
          workspaceState.activeWorkspaceId,
          workspaceState.workspaces,
          workspaceState.collections,
        );
        const existing = bookmarksAsArray(useBookmarksStore.getState().bookmarks)
          .filter((bookmark) => bookmark.collectionId === "" || activeCollectionIds.has(bookmark.collectionId));

        const duplicates: number[] = [];
        const existingCollectionIds = new Set<string>();
        const uniqueTabs: typeof tabsToDrop = [];
        let firstDuplicateBookmarkId: string | null = null;

        for (const tab of tabsToDrop) {
          const existingBookmark = findDuplicateBookmark(existing, tab.url);
          if (existingBookmark) {
            duplicates.push(tab.id);
            firstDuplicateBookmarkId = firstDuplicateBookmarkId ?? existingBookmark.id;
            if (existingBookmark.collectionId) {
              existingCollectionIds.add(existingBookmark.collectionId);
            }
          } else {
            uniqueTabs.push(tab);
          }
        }

        if (duplicates.length > 0) {
          useTabsStore.getState().setHighlightedTabs(duplicates);
          useWorkspaceStore.getState().setHighlightedCollectionIds(Array.from(existingCollectionIds));
          useBookmarksStore.getState().setHighlightedBookmarkId(firstDuplicateBookmarkId);
          showNotification(t(
            duplicates.length === 1
              ? "workspaceVisibility_duplicateTab_one"
              : "workspaceVisibility_duplicateTab_other",
            [duplicates.length.toString()],
          ));
        }

        const newBookmarks = uniqueTabs.map((tab) => ({
          id: generateId(),
          title: tab.title,
          url: tab.url,
          favicon: tab.favIconUrl || "",
          description: "",
          collectionId: target.id,
          tags: [] as string[],
          createdAt: now,
          isFavorite: false,
          seq: 0,
        }));

        if (newBookmarks.length > 0) {
          useBookmarksStore.getState().addBookmarks(newBookmarks);
        }
      }
    };

    const handleDropToSavedGroup = (
      savedGroupId: string,
      tabsToDrop: { title: string; url: string; favIconUrl: string }[]
    ) => {
      const workspaceState = useWorkspaceStore.getState();
      const groupState = useGroupsStore.getState();
      const activeWorkspace = workspaceState.workspaces.find(
        (workspace) => workspace.id === workspaceState.activeWorkspaceId,
      );
      const targetGroup = groupState.groups.find(
        (group) => group.id === savedGroupId
          && !group.deletedAt
          && group.workspaceId === workspaceState.activeWorkspaceId,
      );
      if (!isActiveWorkspace(activeWorkspace) || !targetGroup) {
        showNotification(t("workspaceVisibility_targetUnavailable"));
        return;
      }
      tabsToDrop.forEach((tab) => {
        groupState.addTabToGroup(savedGroupId, {
          title: tab.title,
          url: tab.url,
          favicon: tab.favIconUrl || "",
        });
      });
    };

    if (dragData.type === "tab") {
      if (dropId.startsWith("group-drop-")) {
        const groupId = parseInt(dropId.replace("group-drop-", ""), 10);
        if (!isNaN(groupId)) {
          useTabsStore.getState().moveTabsToGroup([dragData.tabId], groupId);
        }
      } else if (isSavedGroupDropId(dropId)) {
        handleDropToSavedGroup(parseSavedGroupDropId(dropId), [dragData]);
      } else if (isCollectionDropId(dropId)) {
        handleDropToCollection(dropId, [
          {
            id: dragData.tabId,
            title: dragData.title,
            url: dragData.url,
            favIconUrl: dragData.favIconUrl,
          },
        ]);
      }
    }

    if (dragData.type === "tab-group" && isSavedGroupDropId(dropId)) {
      handleDropToSavedGroup(parseSavedGroupDropId(dropId), dragData.tabs.map((tab) => ({
        title: tab.title,
        url: tab.url,
        favIconUrl: tab.favIconUrl || "",
      })));
      return;
    }

    if (dragData.type === "bookmark") {
      if (isCollectionDropId(dropId)) {
        const rawId = parseCollectionDropId(dropId);
        const workspaceState = useWorkspaceStore.getState();
        let targetCollectionId = rawId;
        if (rawId === "all") {
          const activeCollections = getActiveWorkspaceCollections(
            workspaceState.activeWorkspaceId,
            workspaceState.workspaces,
            workspaceState.collections,
          );
          const defaultCol = activeCollections.find((candidate) => candidate.isDefault);
          targetCollectionId = defaultCol?.id ?? "";
        }

        const target = resolveActiveWorkspaceCollectionTarget(
          targetCollectionId,
          workspaceState.activeWorkspaceId,
          workspaceState.workspaces,
          workspaceState.collections,
        );
        if (!target) {
          showNotification(t("workspaceVisibility_targetUnavailable"));
          return;
        }

        const bookmark = useBookmarksStore.getState().bookmarks.get(dragData.bookmarkId);
        if (bookmark && bookmark.collectionId === target.id) {
          showNotification(t("workspaceVisibility_alreadyInCollection"));
          return;
        }

        useBookmarksStore.getState().updateBookmark(dragData.bookmarkId, {
          collectionId: target.id,
        });
      }
    }

    if (dragData.type === "tab-group") {
      if (dropId === "sidebar-groups") {
        const { createGroup, addTabToGroup } = useGroupsStore.getState();
        const workspaceState = useWorkspaceStore.getState();
        const activeWorkspace = workspaceState.workspaces.find(
          (workspace) => workspace.id === workspaceState.activeWorkspaceId,
        );
        if (!isActiveWorkspace(activeWorkspace)) {
          showNotification(t("workspaceVisibility_targetUnavailable"));
          return;
        }
        const savedGroupId = createGroup(
          dragData.groupName || "Unnamed",
          dragData.groupColor,
          true,
          workspaceState.activeWorkspaceId
        );
        dragData.tabs.forEach((tab) => {
          addTabToGroup(savedGroupId, {
            title: tab.title,
            url: tab.url,
            favicon: tab.favIconUrl || "",
          });
        });
      } else if (isCollectionDropId(dropId)) {
        handleDropToCollection(
          dropId,
          dragData.tabs.map((t) => ({
            id: t.id,
            title: t.title,
            url: t.url,
            favIconUrl: t.favIconUrl || "",
          }))
        );
      }
    }
  };

  const handleDragCancel = () => {
    setActiveData(null);
    setOverCollectionId(null);
  };

  const contextValue = React.useMemo(
    () => ({ activeData, overCollectionId }),
    [activeData, overCollectionId]
  );

  return (
    <TabsDndCtx.Provider value={contextValue}>
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        {notification && (
          <Alert className="fixed top-4 left-1/2 -translate-x-1/2 z-100 w-auto shadow-lg animate-in fade-in slide-in-from-top-2 pointer-events-none whitespace-nowrap border-amber-500/50 text-amber-600 bg-amber-50/90 dark:bg-amber-950/20">
            <AlertCircle />
            <AlertDescription className="text-amber-600 dark:text-amber-500">{notification.text}</AlertDescription>
          </Alert>
        )}
        {children}
        <DragOverlay dropAnimation={null}>
          {activeData && <DragPreview data={activeData} />}
        </DragOverlay>
      </DndContext>
    </TabsDndCtx.Provider>
  );
}

function DragPreview({ data }: { data: DragData }) {
  if (data.type === "bookmark") {
    const fakeBookmark = {
      id: data.bookmarkId,
      title: data.title,
      url: data.url,
      favicon: data.favicon,
      description: "",
      collectionId: "",
      tags: [] as string[],
      createdAt: "",
      isFavorite: false,
      seq: 0,
    };
    return (
      <div className="pointer-events-none shadow-2xl rotate-1 opacity-60 overflow-hidden rounded-xl relative">
        <BookmarkCard bookmark={fakeBookmark} variant={data.variant} />
        <div className="absolute inset-0 bg-black/10 rounded-xl" />
      </div>
    );
  }
  if (data.type === "tab") {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg border bg-card shadow-xl opacity-95 pointer-events-none min-w-50">
        <div className="size-6 rounded bg-muted flex items-center justify-center shrink-0 overflow-hidden">
          <FaviconImage src={data.favIconUrl} className="size-4" />
        </div>
        <span className="text-sm truncate">{data.title}</span>
      </div>
    );
  }
  if (data.type === "tab-group") {
    const color = TAB_GROUP_COLORS[data.groupColor];
    return (
      <div
        className="flex items-center gap-2.5 px-3 py-2 rounded-lg border bg-card shadow-xl opacity-95 pointer-events-none"
        style={{ borderLeftColor: color, borderLeftWidth: 3 }}
      >
        <span
          className="size-2.5 rounded-full shrink-0"
          style={{ backgroundColor: color }}
        />
        <span className="text-sm font-medium">
          {data.groupName || "Unnamed group"}
        </span>
        <span className="text-xs text-muted-foreground ml-1">
          {data.tabs.length} tabs
        </span>
      </div>
    );
  }
  return null;
}
