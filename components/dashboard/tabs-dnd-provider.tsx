import React, { createContext, useContext, useState } from "react";
import {
  DndContext,
  DragEndEvent,
  DragStartEvent,
  useSensor,
  useSensors,
  DragOverlay,
} from "@dnd-kit/core";
import { SmartPointerSensor } from "@/lib/drag-sensors";
import { useTabsStore } from "@/store/tabs-store";
import { useGroupsStore } from "@/store/groups-store";
import { useBookmarksStore } from "@/store/bookmarks-store";
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
}

const TabsDndCtx = createContext<TabsDndContextValue>({ activeData: null });

export function useTabsDndContext() {
  return useContext(TabsDndCtx);
}

export function TabsDndProvider({ children }: { children: React.ReactNode }) {
  const [activeData, setActiveData] = useState<DragData | null>(null);
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

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveData(null);
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
      const collectionId = collectionDropId.replace("sidebar-collection-", "");
      let targetCollectionId = collectionId;
      if (collectionId === "all") {
        const { collections, activeWorkspaceId } = useWorkspaceStore.getState();
        const defaultCol = collections.find(
          (c) => c.workspaceId === activeWorkspaceId && c.isDefault
        );
        targetCollectionId = defaultCol?.id || "";
      }

      if (targetCollectionId) {
        const now = new Date().toISOString();
        const { bookmarks: existing } = useBookmarksStore.getState();

        const duplicates: number[] = [];
        const existingCollectionIds = new Set<string>();
        const uniqueTabs: typeof tabsToDrop = [];

        for (const tab of tabsToDrop) {
          const existingBookmark = findDuplicateBookmark(existing, tab.url);
          if (existingBookmark) {
            duplicates.push(tab.id);
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
          showNotification(`Duplicate tab${duplicates.length > 1 ? "s" : ""} detected`);
        }

        const newBookmarks = uniqueTabs.map((tab) => ({
          id: generateId(),
          title: tab.title,
          url: tab.url,
          favicon: tab.favIconUrl || "",
          description: "",
          collectionId: targetCollectionId,
          tags: [] as string[],
          createdAt: now,
          isFavorite: false,
          seq: 0,
        }));

        if (newBookmarks.length > 0) {
          useBookmarksStore.setState((state) => ({
            bookmarks: [...newBookmarks, ...state.bookmarks],
          }));
        }
      }
    };

    if (dragData.type === "tab") {
      if (dropId.startsWith("group-drop-")) {
        const groupId = parseInt(dropId.replace("group-drop-", ""), 10);
        if (!isNaN(groupId)) {
          useTabsStore.getState().moveTabsToGroup([dragData.tabId], groupId);
        }
      } else if (dropId.startsWith("sidebar-collection-")) {
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

    if (dragData.type === "bookmark") {
      if (dropId.startsWith("sidebar-collection-")) {
        const rawId = dropId.replace("sidebar-collection-", "");
        let targetCollectionId = rawId;
        if (rawId === "all") {
          const { collections, activeWorkspaceId } = useWorkspaceStore.getState();
          const defaultCol = collections.find(c => c.workspaceId === activeWorkspaceId && c.isDefault);
          targetCollectionId = defaultCol?.id ?? "";
        }

        const bookmark = useBookmarksStore.getState().bookmarks.find(b => b.id === dragData.bookmarkId);
        if (bookmark && bookmark.collectionId === targetCollectionId) {
          showNotification("Already in this collection");
          return;
        }

        useBookmarksStore.getState().updateBookmark(dragData.bookmarkId, {
          collectionId: targetCollectionId,
        });
      }
    }

    if (dragData.type === "tab-group") {
      if (dropId === "sidebar-groups") {
        const { createGroup, addTabToGroup } = useGroupsStore.getState();
        const savedGroupId = createGroup(
          dragData.groupName || "Unnamed",
          dragData.groupColor,
          true
        );
        dragData.tabs.forEach((tab) => {
          addTabToGroup(savedGroupId, {
            title: tab.title,
            url: tab.url,
            favicon: tab.favIconUrl || "",
          });
        });
      } else if (dropId.startsWith("sidebar-collection-")) {
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

  const handleDragCancel = () => setActiveData(null);

  return (
    <TabsDndCtx.Provider value={{ activeData }}>
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
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
