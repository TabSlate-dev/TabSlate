import { useCallback, useEffect, useRef, useState } from "react";
import { HashRouter, Routes, Route } from "react-router-dom";
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
import { AuthPage } from "@/components/auth/auth-page";
import { VerifyEmailScreen } from "@/components/auth/verify-email-screen";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { useAuthStore } from "@/store/auth-store";
import { useGroupsStore } from "@/store/groups-store";
import { useTabsStore } from "@/store/tabs-store";
import { migrateFromChromeStorage } from "@/lib/idb";
import type { ExtensionMessage } from "@/lib/messages";
import { SyncEngine, type SyncStatus, initSyncEngine, syncEngine, destroySyncEngine } from "@/lib/sync-engine";
import type { SyncPullResponse } from "@/lib/api";
import { Loader2 } from "lucide-react";

function Layout({
  title,
  syncStatus,
  onForceSync,
  children,
}: {
  title?: string;
  syncStatus: SyncStatus;
  onForceSync: () => void;
  children: React.ReactNode;
}) {
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
          <BookmarksSidebar syncStatus={syncStatus} onForceSync={onForceSync} />

          {/* Content area: use h-svh directly so height is always definite */}
          <div className="flex flex-1 h-svh overflow-hidden lg:p-2 lg:gap-2 min-w-0">
            {/* Center content card */}
            <div className="flex-1 flex flex-col lg:border lg:rounded-lg bg-background overflow-hidden min-w-0">
              <BookmarksHeader title={title} />
              {children}
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

  useEffect(() => {
    migrateFromChromeStorage().then(() =>
      Promise.all([
        useBookmarksStore.getState().hydrate(),
        useWorkspaceStore.getState().hydrate(),
        useGroupsStore.getState().hydrate(),
      ]),
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hydrated = bookmarksHydrated && workspaceHydrated && authHydrated && groupsHydrated;

  if (!hydrated) {
    return (
      <div className="flex items-center justify-center h-svh bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <>{children}</>;
}

/** Shows the auth page when no access token is present.
 *  If a token exists but the email is unverified, shows the OTP verification
 *  screen instead of the dashboard — prevents entering without verifying. */
function AuthGate({ children }: { children: React.ReactNode }) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const user = useAuthStore((s) => s.user);

  if (!accessToken) {
    return <AuthPage />;
  }
  if (user && !user.is_verified) {
    return <VerifyEmailScreen email={user.email} />;
  }
  return <>{children}</>;
}

/** Instantiates and manages the SyncEngine lifecycle after auth hydration.
 *  Uses render props to expose syncStatus and onForceSync to children. */
function SyncProvider({
  children,
}: {
  children: (syncStatus: SyncStatus, onForceSync: () => void) => React.ReactNode;
}) {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const accessToken = useAuthStore((s) => s.accessToken);
  const localSeq = useWorkspaceStore((s) => s.localSeq);
  const mergeWorkspaces = useWorkspaceStore((s) => s.mergeFromServer);
  const mergeBookmarks = useBookmarksStore((s) => s.mergeFromServer);
  const setLocalSeq = useWorkspaceStore((s) => s.setLocalSeq);

  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");

  // Keep refs stable so the engine closure always reads the latest values
  // without needing to be recreated on each localSeq change.
  const localSeqRef = useRef(localSeq);
  useEffect(() => { localSeqRef.current = localSeq; }, [localSeq]);

  const mergeWorkspacesRef = useRef(mergeWorkspaces);
  const mergeBookmarksRef = useRef(mergeBookmarks);
  const setLocalSeqRef = useRef(setLocalSeq);

  useEffect(() => {
    if (!accessToken || !serverUrl) return;

    const engine = new SyncEngine(
      () => (accessToken && serverUrl ? { baseUrl: serverUrl, accessToken } : null),
      () => localSeqRef.current,
      (resp: SyncPullResponse) => {
        const needsInitialPush = localSeqRef.current === 0 && resp.server_seq === 0;
        mergeWorkspacesRef.current(resp);
        mergeBookmarksRef.current(resp);
        localSeqRef.current = resp.server_seq;
        setLocalSeqRef.current(resp.server_seq);
        if (needsInitialPush) {
          useWorkspaceStore.getState().enqueueAllToSync();
          useBookmarksStore.getState().enqueueAllToSync();
          // New account: server is empty and local store is also empty → seed default workspace.
          if (useWorkspaceStore.getState().workspaces.length === 0) {
            useWorkspaceStore.getState().createWorkspace("My Workspace", "blue");
          }
        } else {
          useWorkspaceStore.getState().sweepUnsynced();
          useBookmarksStore.getState().sweepUnsynced();
        }
      },
      (_pushResp) => { /* seq updates happen inside mergeFromServer */ },
      setSyncStatus,
    );

    initSyncEngine(engine);
    engine.start();

    return () => {
      engine.forceSync().catch(() => {}).finally(() => destroySyncEngine());
    };
  }, [accessToken, serverUrl]);

  const handleForceSync = useCallback(() => {
    syncEngine?.forceSync().catch(() => {});
  }, []);

  return <>{children(syncStatus, handleForceSync)}</>;
}

export default function App() {
  useEffect(() => {
    const listener = (message: ExtensionMessage) => {
      if (message.type === "ADD_BOOKMARK") {
        useBookmarksStore.getState().addBookmark(message.data);
      }
      if (message.type === "BOOKMARKS_CHANGED") {
        useBookmarksStore.getState().hydrate();
      }
      if (message.type === "WORKSPACE_CHANGED") {
        useWorkspaceStore.getState().hydrate();
      }
      if (message.type === "TABS_CHANGED") {
        useTabsStore.getState().loadTabs();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  return (
    <ThemeProvider>
      <StoreGate>
        <AuthGate>
          <SyncProvider>
            {(syncStatus, onForceSync) => (
              <HashRouter>
                <TabsDndProvider>
                  <Routes>
                    <Route
                      path="/"
                      element={
                        <Layout syncStatus={syncStatus} onForceSync={onForceSync}>
                          <BookmarksContent />
                        </Layout>
                      }
                    />
                    <Route
                      path="/favorites"
                      element={
                        <Layout title="Favorites" syncStatus={syncStatus} onForceSync={onForceSync}>
                          <FavoritesContent />
                        </Layout>
                      }
                    />
                    <Route
                      path="/archive"
                      element={
                        <Layout title="Archive" syncStatus={syncStatus} onForceSync={onForceSync}>
                          <ArchiveContent />
                        </Layout>
                      }
                    />
                    <Route
                      path="/trash"
                      element={
                        <Layout title="Trash" syncStatus={syncStatus} onForceSync={onForceSync}>
                          <TrashContent />
                        </Layout>
                      }
                    />
                    <Route
                      path="/tabs"
                      element={
                        <Layout title="Open Tabs" syncStatus={syncStatus} onForceSync={onForceSync}>
                          <TabsPanel />
                        </Layout>
                      }
                    />
                    <Route
                      path="/groups/:groupId"
                      element={
                        <Layout title="Groups" syncStatus={syncStatus} onForceSync={onForceSync}>
                          <GroupDetail />
                        </Layout>
                      }
                    />
                  </Routes>
                </TabsDndProvider>
              </HashRouter>
            )}
          </SyncProvider>
        </AuthGate>
      </StoreGate>
    </ThemeProvider>
  );
}
