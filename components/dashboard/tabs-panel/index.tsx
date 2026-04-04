import { useState, useCallback, useMemo, useEffect } from "react";
import { useTabsStore } from "@/store/tabs-store";
import { Button } from "@/components/ui/button";
import { Monitor, RefreshCw, FolderPlus, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { GroupCard } from "./group-card";
import { UngroupedSection } from "./ungrouped-section";
import { SaveCollectionDialog } from "./save-collection-dialog";
import { JoinGroupDialog } from "./join-group-dialog";

export function TabsPanel() {
  // Fine-grained selectors
  const openTabs = useTabsStore(s => s.openTabs);
  const tabGroups = useTabsStore(s => s.tabGroups);
  const isLoading = useTabsStore(s => s.isLoading);
  const loadTabs = useTabsStore(s => s.loadTabs);
  const saveWindowAsCollection = useTabsStore(s => s.saveWindowAsCollection);

  const [saveWindowOpen, setSaveWindowOpen] = useState(false);
  const [isSavingWindow, setIsSavingWindow] = useState(false);
  const [saveResult, setSaveResult] = useState<{ saved: number; skipped: number } | null>(null);
  const [selectedTabIds, setSelectedTabIds] = useState<number[]>([]);
  const [isJoinDialogOpen, setIsJoinDialogOpen] = useState(false);

  const handleJoinRequest = useCallback((tabIds: number[]) => {
    setSelectedTabIds(tabIds);
    setIsJoinDialogOpen(true);
  }, []);

  useEffect(() => {
    loadTabs();

    function onStorageChange(
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string
    ) {
      if (area === "local" && "tabslate-tabs-changed" in changes) {
        loadTabs(true);
      }
    }
    chrome.storage.onChanged.addListener(onStorageChange);
    return () => chrome.storage.onChanged.removeListener(onStorageChange);
  }, [loadTabs]);

  // Split tabs into grouped (by groupId) and ungrouped — memoized
  const { grouped, ungrouped } = useMemo(() => {
    const grouped = new Map<number, typeof openTabs>();
    const ungrouped: typeof openTabs = [];
    for (const tab of openTabs) {
      if (tab.groupId !== -1) {
        if (!grouped.has(tab.groupId)) { grouped.set(tab.groupId, []); }
        grouped.get(tab.groupId)!.push(tab);
      } else {
        ungrouped.push(tab);
      }
    }
    return { grouped, ungrouped };
  }, [openTabs]);

  const handleSaveWindow = useCallback(async (name: string, deduplicate: boolean) => {
    setIsSavingWindow(true);
    const result = await saveWindowAsCollection(name, deduplicate);
    setIsSavingWindow(false);
    setSaveWindowOpen(false);
    setSaveResult(result);
    setTimeout(() => setSaveResult(null), 3000);
  }, [saveWindowAsCollection]);

  return (
    <div className="flex-1 w-full overflow-auto">
      <div className="p-4 md:p-6 space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between gap-4 p-4 rounded-xl border bg-card">
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-lg bg-blue-500/10 text-blue-500 flex items-center justify-center">
              <Monitor className="size-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Open Tabs</h2>
              <p className="text-sm text-muted-foreground">
                {isLoading
                  ? "Loading..."
                  : `${openTabs.length} tabs · ${tabGroups.length} group${tabGroups.length !== 1 ? "s" : ""}`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {saveResult && (
              <span className="text-xs text-green-600 font-medium animate-in fade-in slide-in-from-right-1 duration-300">
                Saved {saveResult.saved} {saveResult.skipped > 0 && `(${saveResult.skipped} skipped)`}
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => loadTabs()}
              disabled={isLoading}
            >
              <RefreshCw className={cn("size-4", isLoading && "animate-spin")} />
            </Button>
            <Button
              size="sm"
              onClick={() => setSaveWindowOpen(true)}
              disabled={openTabs.length === 0}
            >
              <FolderPlus className="size-4 mr-1.5" />
              Save Window
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : openTabs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="size-12 rounded-full bg-muted flex items-center justify-center mb-4">
              <Monitor className="size-6 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium mb-1">No tabs open</h3>
            <p className="text-sm text-muted-foreground">
              Open some tabs and they'll appear here.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {ungrouped.length > 0 && (
              <UngroupedSection tabs={ungrouped} onJoinRequest={handleJoinRequest} />
            )}

            {tabGroups.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between px-1">
                  <p className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                    Groups
                  </p>
                  <span className="text-[10px] font-semibold text-muted-foreground">
                    {tabGroups.length}
                  </span>
                </div>
                {tabGroups.map((group) => (
                  <GroupCard
                    key={group.id}
                    group={group}
                    tabs={grouped.get(group.id) ?? []}
                    onJoinRequest={handleJoinRequest}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <SaveCollectionDialog
        open={saveWindowOpen}
        defaultName={`Window ${new Date().toLocaleDateString()}`}
        tabCount={openTabs.length}
        isSaving={isSavingWindow}
        onConfirm={handleSaveWindow}
        onClose={() => setSaveWindowOpen(false)}
      />

      <JoinGroupDialog
        tabIds={selectedTabIds}
        isOpen={isJoinDialogOpen}
        onClose={() => setIsJoinDialogOpen(false)}
      />
    </div>
  );
}
