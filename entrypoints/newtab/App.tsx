import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HashRouter, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { ThemeProvider } from "@/components/theme-provider";
import { TabsDndProvider } from "@/components/dashboard/tabs-dnd-provider";
import { WorkspaceRail } from "@/components/dashboard/workspace-rail";
import { BookmarksSidebar } from "@/components/dashboard/sidebar";
import { BookmarksHeader } from "@/components/dashboard/header";
import { BookmarksContent } from "@/components/dashboard/content";
import { FavoritesContent } from "@/components/dashboard/favorites-content";
import { ArchiveContent } from "@/components/dashboard/archive-content";
import { TrashContent } from "@/components/dashboard/trash-content";
import { TabsPanel } from "@/components/dashboard/tabs-panel";
import { GroupDetail } from "@/components/dashboard/group-detail";
import { TabsRail } from "@/components/dashboard/tabs-rail";
import { SidebarProvider } from "@/components/ui/sidebar";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { useAuthStore } from "@/store/auth-store";
import { useGroupsStore } from "@/store/groups-store";
import { useTabsStore } from "@/store/tabs-store";
import { useSettingsStore } from "@/store/settings-store";
import { usePlanStore, type QuotaResource } from "@/store/plan-store";
import { QuotaAlert } from "@/components/ui/quota-alert";
import type { ExtensionMessage } from "@/lib/messages";
import { analytics } from "@/lib/analytics";
import { SyncEngine, type SyncStatus, initSyncEngine, syncEngine, destroySyncEngine, releaseSyncEngine } from "@/lib/sync-engine";
import type { SyncPullResponse } from "@/lib/api";
import {
  canStartSync,
  resolveAuthSessionStatus,
  shouldInitializeGuestWorkspace,
  shouldResetLocalData,
  type AuthSessionStatus,
} from "@/lib/auth-session";
import { Loader2 } from "lucide-react";
import { syncConflictRegistry } from "@/lib/sync-conflicts";

function PageTracker() {
  const location = useLocation();
  const lastPathRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    const path = location.pathname;
    timerRef.current = setTimeout(() => {
      if (lastPathRef.current === path) {
        return;
      }
      lastPathRef.current = path;
      analytics.track("page_view", { path });
    }, 200);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [location.pathname]);

  return null;
}

const ROUTE_TITLES: Record<string, string> = {
  "/favorites": "Favorites",
  "/archive": "Archive",
  "/trash": "Trash",
  "/tabs": "Open Tabs",
  "/groups": "Groups",
};

function useRouteTitle(): string | undefined {
  const { pathname } = useLocation();

  if (pathname.startsWith("/groups/")) {
    return "Groups";
  }

  return ROUTE_TITLES[pathname];
}

function Layout({
  syncStatus,
  syncErrorMessage,
  onForceSync,
}: {
  syncStatus: SyncStatus;
  syncErrorMessage?: string | null;
  onForceSync: () => void;
}) {
  const title = useRouteTitle();

  return (
    <div className="flex h-svh overflow-hidden bg-sidebar">
      {/* Far-left workspace rail */}
      <WorkspaceRail />

      {/* Wrapper constrains SidebarProvider's w-full to remaining width */}
      <div className="flex flex-1 min-w-0 overflow-hidden">
        {/*
          --sidebar-offset nudges the fixed panel right past the workspace rail.
          SidebarProvider uses its default min-h-svh so height resolves correctly;
          the outer overflow-hidden clips any overflow.
        */}
        <SidebarProvider
          style={{ "--sidebar-offset": "3.25rem" } as React.CSSProperties}
        >
          <BookmarksSidebar syncStatus={syncStatus} syncErrorMessage={syncErrorMessage} onForceSync={onForceSync} />

          {/* Content area: use h-svh directly so height is always definite */}
          <div className="flex flex-1 h-svh overflow-hidden lg:p-2 lg:gap-2 min-w-0">
            {/* Center content card */}
            <div className="flex-1 flex flex-col lg:border lg:rounded-lg bg-background overflow-hidden min-w-0">
              <BookmarksHeader title={title} />
              <Outlet />
            </div>

            {/* Right open-tabs rail */}
            <div className="hidden lg:flex lg:rounded-lg lg:border overflow-hidden shrink-0">
              <TabsRail />
            </div>
          </div>
        </SidebarProvider>
      </div>
    </div>
  );
}

/** Runs one-time storage migration then hydrates all stores from IndexedDB before rendering */
function StoreGate({ children }: { children: React.ReactNode }) {
  const bookmarksHydrated = useBookmarksStore((s) => s._hydrated);
  const workspaceHydrated = useWorkspaceStore((s) => s._hydrated);
  const authHydrated = useAuthStore((s) => s._hydrated);
  const groupsHydrated = useGroupsStore((s) => s._hydrated);
  const settingsHydrated = useSettingsStore((s) => s._hydrated);
  const accessToken = useAuthStore((s) => s.accessToken);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const user = useAuthStore((s) => s.user);
  const workspaceCount = useWorkspaceStore((s) => s.workspaces.length);
  const initializeGuestWorkspace = useWorkspaceStore((s) => s.initializeGuestWorkspace);
  const prevSessionStatusRef = useRef<AuthSessionStatus | null>(null);

  const hydrated =
    bookmarksHydrated &&
    workspaceHydrated &&
    authHydrated &&
    groupsHydrated &&
    settingsHydrated;
  const sessionStatus = resolveAuthSessionStatus({
    accessToken,
    refreshToken,
    isVerified: user?.is_verified ?? null,
  });

  useEffect(() => {
    void Promise.all([
      useBookmarksStore.getState().hydrate(),
      useWorkspaceStore.getState().hydrate(),
      useGroupsStore.getState().hydrate(),
      useSettingsStore.getState().hydrate(),
    ]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (shouldResetLocalData(prevSessionStatusRef.current, sessionStatus)) {
      useWorkspaceStore.getState().reset();
      useBookmarksStore.getState().reset();
      useGroupsStore.getState().reset();
      useSettingsStore.getState().reset();
      usePlanStore.getState().clear();
      syncConflictRegistry.reset();
    }
    prevSessionStatusRef.current = sessionStatus;
  }, [sessionStatus]);

  useEffect(() => {
    if (!hydrated || sessionStatus !== "guest") {
      return;
    }

    usePlanStore.getState().clear();
    if (shouldInitializeGuestWorkspace({
      sessionStatus,
      storesHydrated: hydrated,
      workspaceCount,
    })) {
      void initializeGuestWorkspace();
    }
  }, [hydrated, initializeGuestWorkspace, sessionStatus, workspaceCount]);

  if (!hydrated) {
    return (
      <div className="flex items-center justify-center h-svh bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <>{children}</>;
}

/** Instantiates and manages the SyncEngine lifecycle after auth hydration.
 *  Uses render props to expose syncStatus, onForceSync, and syncErrorMessage to children. */
function SyncProvider({
  children,
}: {
  children: (syncStatus: SyncStatus, onForceSync: () => void, syncErrorMessage: string | null) => React.ReactNode;
}) {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const accessToken = useAuthStore((s) => s.accessToken);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const user = useAuthStore((s) => s.user);
  const localSeq = useWorkspaceStore((s) => s.localSeq);
  const mergeWorkspaces = useWorkspaceStore((s) => s.mergeFromServer);
  const mergeBookmarks = useBookmarksStore((s) => s.mergeFromServer);
  const mergeGroups = useGroupsStore((s) => s.mergeFromServer);
  const setLocalSeq = useWorkspaceStore((s) => s.setLocalSeq);

  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [syncErrorMessage, setSyncErrorMessage] = useState<string | null>(null);
  const sessionStatus = resolveAuthSessionStatus({
    accessToken,
    refreshToken,
    isVerified: user?.is_verified ?? null,
  });
  const syncEnabled = canStartSync(sessionStatus, serverUrl);

  // Keep refs stable so the engine closure always reads the latest values
  // without needing to be recreated on each localSeq change.
  const localSeqRef = useRef(localSeq);
  useEffect(() => { localSeqRef.current = localSeq; }, [localSeq]);

  const mergeWorkspacesRef = useRef(mergeWorkspaces);
  const mergeBookmarksRef = useRef(mergeBookmarks);
  const mergeGroupsRef = useRef(mergeGroups);
  const setLocalSeqRef = useRef(setLocalSeq);

  useEffect(() => { mergeWorkspacesRef.current = mergeWorkspaces; }, [mergeWorkspaces]);
  useEffect(() => { mergeBookmarksRef.current = mergeBookmarks; }, [mergeBookmarks]);
  useEffect(() => { mergeGroupsRef.current = mergeGroups; }, [mergeGroups]);

  useEffect(() => {
    if (syncEnabled) {
      void usePlanStore.getState().fetchPlan();
    }
  }, [syncEnabled]);

  useEffect(() => {
    if (!syncEnabled || !accessToken) {
      return;
    }

    // Pull user preferences from server on login
    useSettingsStore.getState().pullFromServer(serverUrl, accessToken);

    const engine = new SyncEngine(
      () => {
        const currentAuth = useAuthStore.getState();
        if (!currentAuth.accessToken || !currentAuth.serverUrl) {
          return null;
        }
        return {
          baseUrl: currentAuth.serverUrl,
          accessToken: currentAuth.accessToken,
        };
      },
      () => localSeqRef.current,
      async (resp: SyncPullResponse) => {
        const needsInitialPush = localSeqRef.current === 0 && resp.server_seq === 0;
        mergeWorkspacesRef.current(resp);
        mergeGroupsRef.current(resp);
        await mergeBookmarksRef.current(resp);
        localSeqRef.current = resp.server_seq;
        setLocalSeqRef.current(resp.server_seq);
        if (needsInitialPush) {
          useWorkspaceStore.getState().enqueueAllToSync();
          useBookmarksStore.getState().enqueueAllToSync();
          useGroupsStore.getState().enqueueAllToSync();
          // New account: server is empty and local store is also empty → seed default workspace.
          if (useWorkspaceStore.getState().workspaces.length === 0) {
            await useWorkspaceStore.getState().initializeGuestWorkspace();
          }
        } else {
          await useWorkspaceStore.getState().sweepUnsynced();
          await useBookmarksStore.getState().sweepUnsynced();
          await useGroupsStore.getState().sweepUnsynced();
        }
        // A remote pull may change usage without any local create/delete action,
        // so bypass the TTL cache and refresh the authoritative counters.
        usePlanStore.getState().ensureFresh(true);
      },
      (pushResp) => {
        for (const rejected of pushResp.rejected) {
          if (rejected.reason === "quota_exceeded") {
            const resourceMap: Record<string, QuotaResource> = {
              collection: "collection",
              saved_group: "saved_group",
              workspace: "workspace",
            };
            const resource = rejected.type ? resourceMap[rejected.type] : undefined;
            if (resource) { usePlanStore.getState().showQuotaAlert(resource); }
          }
        }
        if (pushResp.rejected.some((r) => r.reason === "quota_exceeded")) {
          void usePlanStore.getState().fetchPlan();
        }
      },
      (status, errorMessage) => {
        setSyncStatus(status);
        setSyncErrorMessage(status === "error" ? (errorMessage ?? null) : null);
      },
    );

    initSyncEngine(engine);
    engine.start();

    return () => {
      // Capture the engine reference before async work begins.
      // destroySyncEngine() must NOT be used here — by the time .finally() fires,
      // the global syncEngine already points to the new engine and would destroy it.
      // Instead, destroy this specific engine instance directly.
      void engine.forceSync().catch(() => {});
      engine.destroy();
      releaseSyncEngine(engine);
    };
  }, [syncEnabled, serverUrl]);

  const effectiveSyncStatus = useMemo<SyncStatus>(
    () => sessionStatus === "offline" ? "offline" : syncStatus,
    [sessionStatus, syncStatus],
  );

  const handleForceSync = useCallback(() => {
    if (syncEngine) {
      // Normal path: engine is running, trigger a full sync cycle.
      syncEngine.forceSync().catch(() => {});
    } else if (serverUrl) {
      // No engine = accessToken is absent (silentRefresh failed while backend was unreachable).
      // Retry the token refresh; on success the SyncProvider effect will (re)create the engine.
      void useAuthStore.getState().silentRefresh();
    }
  }, [serverUrl]);

  return <>{children(effectiveSyncStatus, handleForceSync, syncErrorMessage)}</>;
}

export default function App() {
  useEffect(() => {
    const listener = (message: ExtensionMessage) => {
      if (message.type === "ADD_BOOKMARK") {
        useBookmarksStore.getState().addBookmark(message.data);
      }
      if (message.type === "BOOKMARKS_CHANGED") {
        void useBookmarksStore.getState().reloadActive();
      }
      if (message.type === "WORKSPACE_CHANGED") {
        useWorkspaceStore.getState().hydrate();
      }
      if (message.type === "TABS_CHANGED") {
        useTabsStore.getState().loadTabs(true);
      }
      if (message.type === "OPEN_SEARCH") {
        window.dispatchEvent(new CustomEvent("tabslate-focus-search"));
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  return (
    <ThemeProvider>
      <StoreGate>
        <QuotaAlert />
        <SyncProvider>
          {(syncStatus, onForceSync, syncErrorMessage) => (
            <HashRouter>
              <PageTracker />
              <TabsDndProvider>
                <Routes>
                  <Route
                    path="/"
                    element={
                      <Layout
                        syncStatus={syncStatus}
                        syncErrorMessage={syncErrorMessage}
                        onForceSync={onForceSync}
                      />
                    }
                  >
                    <Route index element={<BookmarksContent />} />
                    <Route path="favorites" element={<FavoritesContent />} />
                    <Route path="archive" element={<ArchiveContent />} />
                    <Route path="trash" element={<TrashContent />} />
                    <Route path="tabs" element={<TabsPanel />} />
                    <Route path="groups/:groupId" element={<GroupDetail />} />
                  </Route>
                </Routes>
              </TabsDndProvider>
            </HashRouter>
          )}
        </SyncProvider>
      </StoreGate>
    </ThemeProvider>
  );
}
