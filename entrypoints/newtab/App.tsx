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
import { SyncRecoveryAlert } from "@/components/ui/sync-recovery-alert";
import { useTranslation } from "@/hooks/use-translation";
import type { ExtensionMessage } from "@/lib/messages";
import { analytics } from "@/lib/analytics";
import { type SyncStatus, initSyncEngine, syncEngine, releaseSyncEngine } from "@/lib/sync-engine";
import { createSyncEngine } from "@/lib/sync-engine-runtime";
import { registerSyncLifecycle, unregisterSyncLifecycle } from "@/lib/sync-lifecycle";
import { api, type SyncPullResponse } from "@/lib/api";
import {
  canStartSync,
  resolveAuthSessionStatus,
  shouldInitializeGuestWorkspace,
  shouldResetLocalData,
  type AuthSessionStatus,
} from "@/lib/auth-session";
import { Loader2 } from "lucide-react";
import { syncConflictRegistry } from "@/lib/sync-conflicts";
import {
  clearCapacityResolvedConflicts,
  confirmGuestWorkspaceFromPull,
  getPersistentSyncErrorKey,
  prepareGuestWorkspaceForPull,
  resolveGuestPushRejections,
  resolveLegacyGuestWorkspaceFailure,
  sweepAllUnsynced,
} from "@/lib/guest-workspace-reconciliation";

function quotaResourceForRejectedType(type: string | undefined): QuotaResource | null {
  if (type === "bookmark") {
    return "bookmark";
  }
  if (type === "collection") {
    return "collection";
  }
  if (type === "tag") {
    return "tag";
  }
  if (type === "workspace") {
    return "workspace";
  }
  if (type === "saved_group") {
    return "saved_group";
  }
  return null;
}

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
      void initializeGuestWorkspace({
        isSessionCurrent: () => resolveAuthSessionStatus({
          accessToken: useAuthStore.getState().accessToken,
          refreshToken: useAuthStore.getState().refreshToken,
          isVerified: useAuthStore.getState().user?.is_verified ?? null,
        }) === "guest",
      });
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
  const { t } = useTranslation();

  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [syncErrorMessage, setSyncErrorMessage] = useState<string | null>(null);
  const [recoveryWorkspaceName, setRecoveryWorkspaceName] = useState<string | null>(null);
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
  const tRef = useRef(t);
  const recoveryNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { mergeWorkspacesRef.current = mergeWorkspaces; }, [mergeWorkspaces]);
  useEffect(() => { mergeBookmarksRef.current = mergeBookmarks; }, [mergeBookmarks]);
  useEffect(() => { mergeGroupsRef.current = mergeGroups; }, [mergeGroups]);
  useEffect(() => { setLocalSeqRef.current = setLocalSeq; }, [setLocalSeq]);
  useEffect(() => { tRef.current = t; }, [t]);

  const showRecoveryNotice = useCallback((targetWorkspaceName: string | undefined) => {
    if (!targetWorkspaceName) {
      return;
    }
    if (recoveryNoticeTimerRef.current) {
      clearTimeout(recoveryNoticeTimerRef.current);
    }
    setRecoveryWorkspaceName(targetWorkspaceName);
    recoveryNoticeTimerRef.current = setTimeout(() => {
      setRecoveryWorkspaceName(null);
      recoveryNoticeTimerRef.current = null;
    }, 4000);
  }, []);

  useEffect(() => () => {
    if (recoveryNoticeTimerRef.current) {
      clearTimeout(recoveryNoticeTimerRef.current);
    }
  }, []);

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

    const engine = createSyncEngine(
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
      async (resp: SyncPullResponse, isCurrent) => {
        if (!isCurrent()) {
          return null;
        }
        const needsInitialPush = localSeqRef.current === 0 && resp.server_seq === 0;
        await prepareGuestWorkspaceForPull(resp);
        if (!isCurrent()) {
          return null;
        }
        await mergeWorkspacesRef.current(resp);
        if (!isCurrent()) {
          return null;
        }
        await mergeGroupsRef.current(resp);
        if (!isCurrent()) {
          return null;
        }
        await mergeBookmarksRef.current(resp);
        if (!isCurrent()) {
          return null;
        }
        await confirmGuestWorkspaceFromPull(resp);
        if (!isCurrent()) {
          return null;
        }
        await setLocalSeqRef.current(resp.server_seq);
        localSeqRef.current = resp.server_seq;

        if (needsInitialPush && useWorkspaceStore.getState().workspaces.length === 0) {
          await useWorkspaceStore.getState().initializeGuestWorkspace({
            isSessionCurrent: () => isCurrent() && useAuthStore.getState().accessToken === accessToken,
          });
        }
        if (!isCurrent()) {
          return null;
        }
        await sweepAllUnsynced();
        if (!isCurrent()) {
          return null;
        }
        const refreshedPlan = await usePlanStore.getState().fetchPlan();
        if (!isCurrent()) {
          return null;
        }
        if (refreshedPlan && await clearCapacityResolvedConflicts(refreshedPlan)) {
          await sweepAllUnsynced();
        }
        if (!isCurrent()) {
          return null;
        }
        const persistentErrorKey = await getPersistentSyncErrorKey();
        return persistentErrorKey ? tRef.current(persistentErrorKey) : null;
      },
      async (pushResp) => {
        const reconciliation = await resolveGuestPushRejections(pushResp);
        const quotaResources = new Set<QuotaResource>();
        for (const rejected of pushResp.rejected) {
          if (rejected.reason !== "quota_exceeded") {
            continue;
          }
          const resource = quotaResourceForRejectedType(rejected.type);
          if (resource) {
            quotaResources.add(resource);
          }
        }
        for (const resource of quotaResources) {
          usePlanStore.getState().showQuotaAlert(resource);
        }
        if (quotaResources.size > 0) {
          await usePlanStore.getState().fetchPlan();
        }
        if (reconciliation.kind === "migrated") {
          showRecoveryNotice(reconciliation.targetWorkspaceName);
          await sweepAllUnsynced();
        }
        const persistentErrorKey = await getPersistentSyncErrorKey();
        return persistentErrorKey ? tRef.current(persistentErrorKey) : null;
      },
      (status, errorMessage) => {
        setSyncStatus(status);
        setSyncErrorMessage(status === "error" ? (errorMessage ?? null) : null);
      },
      async (failure) => {
        if (failure.status !== 500) {
          return false;
        }
        const currentAuth = useAuthStore.getState();
        if (!currentAuth.serverUrl || !currentAuth.accessToken) {
          return false;
        }
        const [remote, plan] = await Promise.all([
          api.syncPull(currentAuth.serverUrl, currentAuth.accessToken, 0),
          usePlanStore.getState().fetchPlan(),
        ]);
        if (!plan) {
          return false;
        }
        const reconciliation = await resolveLegacyGuestWorkspaceFailure(plan, remote);
        if (reconciliation.kind !== "migrated") {
          return false;
        }
        showRecoveryNotice(reconciliation.targetWorkspaceName);
        await sweepAllUnsynced();
        return true;
      },
    );

    initSyncEngine(engine);
    registerSyncLifecycle(engine);
    engine.start();

    return () => {
      // Capture the engine reference before async work begins.
      // destroySyncEngine() must NOT be used here — by the time .finally() fires,
      // the global syncEngine already points to the new engine and would destroy it.
      // Instead, destroy this specific engine instance directly.
      void engine.forceSync().catch(() => {});
      engine.destroy();
      unregisterSyncLifecycle(engine);
      releaseSyncEngine(engine);
    };
  }, [showRecoveryNotice, syncEnabled, serverUrl]);

  const effectiveSyncStatus = useMemo<SyncStatus>(
    () => sessionStatus === "offline" ? "offline" : syncStatus,
    [sessionStatus, syncStatus],
  );

  const handleForceSync = useCallback(() => {
    void (async () => {
      await syncConflictRegistry.clearAllForManualRetry();
      await sweepAllUnsynced();
      if (syncEngine) {
        await syncEngine.forceSync();
        return;
      }
      if (serverUrl) {
        await useAuthStore.getState().silentRefresh();
      }
    })();
  }, [serverUrl]);

  return (
    <>
      <SyncRecoveryAlert targetWorkspaceName={recoveryWorkspaceName} />
      {children(effectiveSyncStatus, handleForceSync, syncErrorMessage)}
    </>
  );
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
