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
import { Loader2 } from "lucide-react";

function Layout({
  title,
  children,
}: {
  title?: string;
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
          <BookmarksSidebar />

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

/** Waits for all stores to rehydrate from chrome.storage before rendering */
function StoreGate({ children }: { children: React.ReactNode }) {
  const bookmarksHydrated = useBookmarksStore((s) => s._hydrated);
  const workspaceHydrated = useWorkspaceStore((s) => s._hydrated);
  const authHydrated = useAuthStore((s) => s._hydrated);
  const hydrated = bookmarksHydrated && workspaceHydrated && authHydrated;

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

export default function App() {
  return (
    <ThemeProvider>
      <StoreGate>
        <AuthGate>
          <HashRouter>
            <TabsDndProvider>
              <Routes>
                <Route
                  path="/"
                  element={
                    <Layout>
                      <BookmarksContent />
                    </Layout>
                  }
                />
                <Route
                  path="/favorites"
                  element={
                    <Layout title="Favorites">
                      <FavoritesContent />
                    </Layout>
                  }
                />
                <Route
                  path="/archive"
                  element={
                    <Layout title="Archive">
                      <ArchiveContent />
                    </Layout>
                  }
                />
                <Route
                  path="/trash"
                  element={
                    <Layout title="Trash">
                      <TrashContent />
                    </Layout>
                  }
                />
                <Route
                  path="/tabs"
                  element={
                    <Layout title="Open Tabs">
                      <TabsPanel />
                    </Layout>
                  }
                />
                <Route
                  path="/groups/:groupId"
                  element={
                    <Layout title="Groups">
                      <GroupDetail />
                    </Layout>
                  }
                />
              </Routes>
            </TabsDndProvider>
          </HashRouter>
        </AuthGate>
      </StoreGate>
    </ThemeProvider>
  );
}
