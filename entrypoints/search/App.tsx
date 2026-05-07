import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { ThemeProvider } from "@/components/theme-provider";
import { SearchPanel } from "@/components/search/search-panel";
import { useAuthStore } from "@/store/auth-store";
import { useTabsStore } from "@/store/tabs-store";

export function SearchApp() {
  const authHydrated = useAuthStore(s => s._hydrated);
  const openTabs = useTabsStore(s => s.openTabs);
  const loadTabs = useTabsStore(s => s.loadTabs);
  const [tabsReady, setTabsReady] = useState(false);

  useEffect(() => {
    loadTabs(true).then(() => setTabsReady(true));
  }, [loadTabs]);

  if (!authHydrated || !tabsReady) {
    return (
      <div className="flex items-center justify-center w-full h-full min-h-[80px]">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <ThemeProvider>
      <div className="p-3 w-full">
        <SearchPanel
          openTabs={openTabs}
          autoFocus
          onClose={() => window.close()}
        />
      </div>
    </ThemeProvider>
  );
}
