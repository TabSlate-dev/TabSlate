import React, { createContext, useContext, useState } from "react";
import {
  DndContext,
  DragEndEvent,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
} from "@dnd-kit/core";
import { useTabsStore } from "@/store/tabs-store";
import { useGroupsStore } from "@/store/groups-store";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { generateId } from "@/lib/id";
import { findDuplicateBookmark } from "@/lib/bookmark-utils";
import type { BrowserTab } from "@/lib/chrome/tabs";
import type { TabGroupColor } from "@/lib/chrome/tab-groups";
import { TAB_GROUP_COLORS } from "@/lib/chrome/tab-groups";
import { FaviconImage } from "@/components/ui/favicon-image";

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

export type DragData = TabDragData | TabGroupDragData;

interface TabsDndContextValue {
  activeData: DragData | null;
}

const TabsDndCtx = createContext<TabsDndContextValue>({ activeData: null });

export function useTabsDndContext() {
  return useContext(TabsDndCtx);
}

export function TabsDndProvider({ children }: { children: React.ReactNode }) {
  const [activeData, setActiveData] = useState<DragData | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveData((event.active.data.current as DragData) ?? null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveData(null);
    const { active, over } = event;

    const dragData = active.data.current as DragData | undefined;
    if (!dragData) return;

    // Tab dropped on empty space → ungroup if it was in a group
    if (!over) {
      if (dragData.type === "tab" && dragData.fromGroupId !== -1) {
        useTabsStore.getState().ungroupSpecificTabs([dragData.tabId]);
      }
      return;
    }

    const dropId = over.id as string;

    if (dragData.type === "tab") {
      if (dropId.startsWith("group-drop-")) {
        const groupId = parseInt(dropId.replace("group-drop-", ""), 10);
        if (!isNaN(groupId)) {
          useTabsStore.getState().moveTabsToGroup([dragData.tabId], groupId);
        }
      }
    }

    if (dragData.type === "tab-group") {
      if (dropId === "sidebar-groups") {
        const { createGroup, addTabToGroup } = useGroupsStore.getState();
        const savedGroupId = createGroup(
          dragData.groupName || "Unnamed",
          dragData.groupColor
        );
        dragData.tabs.forEach((tab) => {
          addTabToGroup(savedGroupId, {
            title: tab.title,
            url: tab.url,
            favicon: tab.favIconUrl || "",
          });
        });
      } else if (dropId.startsWith("sidebar-collection-")) {
        const collectionId = dropId.replace("sidebar-collection-", "");
        let targetCollectionId = collectionId;
        if (collectionId === "all") {
          const { collections, activeWorkspaceId } =
            useWorkspaceStore.getState();
          const defaultCol = collections.find(
            (c) => c.workspaceId === activeWorkspaceId && c.isDefault
          );
          targetCollectionId = defaultCol?.id || "";
        }
        if (targetCollectionId) {
          const now = new Date().toISOString();
          // Filter duplicates before building the batch — reuses shared normalizeUrl logic.
          const { bookmarks: existing } = useBookmarksStore.getState();
          const newBookmarks = dragData.tabs
            .filter((tab) => !findDuplicateBookmark(existing, tab.url))
            .map((tab) => ({
              id: generateId(),
              title: tab.title,
              url: tab.url,
              favicon: tab.favIconUrl || "",
              description: "",
              collectionId: targetCollectionId,
              tags: [] as string[],
              createdAt: now,
              isFavorite: false,
            }));
          if (newBookmarks.length > 0) {
            useBookmarksStore.setState((state) => ({
              bookmarks: [...newBookmarks, ...state.bookmarks],
            }));
          }
        }
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
        {children}
        <DragOverlay dropAnimation={null}>
          {activeData && <DragPreview data={activeData} />}
        </DragOverlay>
      </DndContext>
    </TabsDndCtx.Provider>
  );
}

function DragPreview({ data }: { data: DragData }) {
  if (data.type === "tab") {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg border bg-card shadow-xl opacity-95 pointer-events-none max-w-[240px]">
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
