import { useEffect, useRef, useState } from "react";
import { useTabsStore } from "@/store/tabs-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  TAB_GROUP_COLORS,
  TAB_GROUP_COLOR_KEYS,
  type TabGroupColor,
  type BrowserTabGroup,
} from "@/lib/chrome/tab-groups";
import type { BrowserTab } from "@/lib/chrome/tabs";
import {
  Monitor,
  RefreshCw,
  FolderPlus,
  Bookmark,
  ExternalLink,
  X,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Layers,
  Loader2,
  Check,
  Ungroup,
  Save,
  Plus,
  BrushCleaning,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { storageService } from "@/lib/storage";
import { useWorkspaceStore } from "@/store/workspace-store";
import { Switch } from "@/components/ui/switch";
import { TabRow } from "./tab-row";

// ---------------------------------------------------------------------------
// Join Group Dialog
// ---------------------------------------------------------------------------
function JoinGroupDialog({
  tabIds,
  isOpen,
  onClose,
}: {
  tabIds: number[];
  isOpen: boolean;
  onClose: () => void;
}) {
  const { tabGroups, moveTabsToGroup, fullTitles } = useTabsStore();

  if (!tabIds.length) return null;

  const handleJoin = async (groupId: number) => {
    await moveTabsToGroup(tabIds, groupId);
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Join Tab Group</DialogTitle>
          <DialogDescription>
            Select an existing group to move the selected tab(s) into.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 py-4 max-h-[300px] overflow-y-auto pr-1">
          {tabGroups.map((group) => {
            const color = TAB_GROUP_COLORS[group.color];
            return (
              <button
                key={group.id}
                onClick={() => handleJoin(group.id)}
                className="flex items-center gap-3 w-full p-2.5 rounded-lg border hover:bg-accent transition-colors text-left"
              >
                <div
                  className="size-3 rounded-full shrink-0"
                  style={{ backgroundColor: color }}
                />
                <span className="text-sm font-medium truncate">
                  {(fullTitles && fullTitles[group.id]) || group.title || "Unnamed Group"}
                </span>
              </button>
            );
          })}
          {tabGroups.length === 0 && (
            <p className="text-sm text-center text-muted-foreground py-4">
              No active groups found.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Group color dot
// ---------------------------------------------------------------------------
function GroupDot({ color }: { color: TabGroupColor }) {
  return (
    <span
      className="inline-block size-3 rounded-full shrink-0"
      style={{ backgroundColor: TAB_GROUP_COLORS[color] }}
    />
  );
}

// ---------------------------------------------------------------------------
// Single tab row (inside or outside a group)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Color picker
// ---------------------------------------------------------------------------
function ColorPicker({
  value,
  onChange,
}: {
  value: TabGroupColor;
  onChange: (c: TabGroupColor) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {TAB_GROUP_COLOR_KEYS.map((color) => (
        <button
          key={color}
          title={color}
          onClick={() => onChange(color)}
          className={cn(
            "size-5 rounded-full transition-transform hover:scale-110 ring-offset-1",
            value === color && "ring-2 ring-offset-background"
          )}
          style={{
            backgroundColor: TAB_GROUP_COLORS[color],
            outline: value === color ? `2px solid ${TAB_GROUP_COLORS[color]}` : "none",
            outlineOffset: "2px",
          }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab group card
// ---------------------------------------------------------------------------
interface GroupCardProps {
  group: BrowserTabGroup;
  tabs: BrowserTab[];
}

function GroupCard({ group, tabs, onJoinRequest }: {
  group: BrowserTabGroup;
  tabs: BrowserTab[];
  onJoinRequest: (tabIds: number[]) => void;
}) {
  const { updateGroup, dissolveGroup, saveGroupAsCollection, toggleGroupCompact, fullTitles, ungroupSpecificTabs, closeSpecificTabs } = useTabsStore();
  const { compactGroupTitles, setCompactGroupTitles } = useWorkspaceStore();
  const [expanded, setExpanded] = useState(true);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const displayTitle = (fullTitles && fullTitles[group.id]) || group.title;
  const [isSaving, setIsSaving] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const nameRef = useRef<HTMLInputElement>(null);

  // We don't need the local useeffect anymore as it's in the store

  const toggleSelect = (tabId: number, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      checked ? next.add(tabId) : next.delete(tabId);
      return next;
    });
  };

  const handleUngroupSelected = async () => {
    await ungroupSpecificTabs(Array.from(selected));
    setSelected(new Set());
  };

  const groupColor = TAB_GROUP_COLORS[group.color];

  const handleNameCommit = () => {
    if (nameInput.trim() !== group.title) {
      updateGroup(group.id, { title: nameInput.trim() });
    }
    setEditingName(false);
  };

  const handleSaveGroup = async (name: string) => {
    setIsSaving(true);
    await saveGroupAsCollection(group.id, name);
    setIsSaving(false);
    setSaveDialogOpen(false);
  };

  return (
    <div
      className="rounded-lg border overflow-hidden"
      style={{ borderLeftColor: groupColor, borderLeftWidth: 3 }}
    >
      {/* Group header */}
      <div className="flex items-center gap-2 px-3 py-2.5 bg-card">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
        </button>

        <GroupDot color={group.color} />

        {editingName ? (
          <Input
            ref={nameRef}
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onBlur={handleNameCommit}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleNameCommit();
              if (e.key === "Escape") {
                setNameInput(displayTitle);
                setEditingName(false);
              }
            }}
            className="h-7 text-sm py-0 w-32"
            autoFocus
          />
        ) : (
          <button
            onClick={() => {
              setEditingName(true);
              setNameInput(displayTitle);
            }}
            className="text-sm font-semibold hover:text-primary transition-colors truncate max-w-[150px]"
            title="Click to rename"
          >
            {displayTitle || "Unnamed group"}
          </button>
        )}

        {selected.size > 0 && (
          <>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={handleUngroupSelected}
              className="size-6 text-destructive hover:bg-destructive/10 transition-colors shrink-0 ml-1"
              title={`Ungroup ${selected.size} selected tab${selected.size !== 1 ? "s" : ""}`}
            >
              <BrushCleaning className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => {
                closeSpecificTabs(Array.from(selected));
                setSelected(new Set());
              }}
              className="size-6 text-destructive hover:bg-destructive/10 transition-colors shrink-0 ml-1"
              title={`Close ${selected.size} selected tab${selected.size !== 1 ? "s" : ""}`}
            >
              <X className="size-3.5" />
            </Button>
          </>
        )}

        <div className="flex items-center gap-1 shrink-0 ml-auto">
          <span className="text-xs text-muted-foreground mr-2 shrink-0">
            {tabs.length} tab{tabs.length !== 1 ? "s" : ""}
          </span>
          {/* Color picker */}
          <div className="flex items-center gap-1 shrink-0 px-2">
            {TAB_GROUP_COLOR_KEYS.map((c) => (
              <button
                key={c}
                title={c}
                onClick={() => updateGroup(group.id, { color: c })}
                className="size-3.5 rounded-full hover:scale-110 transition-transform"
                style={{
                  backgroundColor: TAB_GROUP_COLORS[c],
                  outline: c === group.color ? `2px solid ${TAB_GROUP_COLORS[c]}` : "none",
                  outlineOffset: "2px",
                }}
              />
            ))}
          </div>

          {/* Compact Toggle */}
          <div className="flex items-center gap-1.5 px-2 border-l border-r border-border/50">
            <Switch
              checked={group.title.length === 1}
              onCheckedChange={() => toggleGroupCompact(group.id)}
              className="scale-75"
              title="Toggle Compact Mode for this Group"
            />
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-tight">
              Compact
            </span>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" className="size-6 shrink-0">
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setSaveDialogOpen(true)}>
                <Save className="size-4 mr-2" />
                Save as Collection
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => dissolveGroup(group.id)}
              >
                <Ungroup className="size-4 mr-2" />
                Ungroup Tabs
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Tabs */}
      {expanded && (
        <div className="px-2 pb-2 pt-1 bg-card/50 space-y-0.5">
          {tabs.map((tab) => (
            <TabRow
              key={tab.id}
              tab={tab}
              showCheckbox
              selected={selected.has(tab.id)}
              onSelect={(checked) => toggleSelect(tab.id, checked)}
              onUngroup={() => ungroupSpecificTabs([tab.id])}
              onJoinGroup={() => onJoinRequest([tab.id])}
            />
          ))}
        </div>
      )}

      {/* Save as collection dialog */}
      <SaveCollectionDialog
        open={saveDialogOpen}
        defaultName={group.title}
        tabCount={tabs.length}
        isSaving={isSaving}
        onConfirm={handleSaveGroup}
        onClose={() => setSaveDialogOpen(false)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ungrouped tabs section with multi-select + group creation
// ---------------------------------------------------------------------------
function UngroupedSection({ tabs, onJoinRequest }: {
  tabs: BrowserTab[];
  onJoinRequest: (tabIds: number[]) => void;
}) {
  const { createGroup } = useTabsStore();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [groupName, setGroupName] = useState("");
  const [groupColor, setGroupColor] = useState<TabGroupColor>("blue");
  const [isCompact, setIsCompact] = useState(true); // Default to true
  const [isCreating, setIsCreating] = useState(false);

  const toggleSelect = (tabId: number, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      checked ? next.add(tabId) : next.delete(tabId);
      return next;
    });
  };

  const handleCreateGroup = async () => {
    if (!selected.size || isCreating) return;
    setIsCreating(true);
    await createGroup(Array.from(selected), groupName.trim(), groupColor, isCompact);
    setSelected(new Set());
    setGroupName("");
    setIsCreating(false);
  };

  if (tabs.length === 0) return null;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between px-1">
        <p className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
          Ungrouped
        </p>
        <span className="text-[10px] font-semibold text-muted-foreground">
          {tabs.length}
        </span>
      </div>

      <div className="rounded-lg border bg-card divide-y divide-border/50">
        {tabs.map((tab) => (
          <TabRow
            key={tab.id}
            tab={tab}
            showCheckbox
            selected={selected.has(tab.id)}
            onSelect={(checked) => toggleSelect(tab.id, checked)}
            onJoinGroup={() => onJoinRequest([tab.id])}
            isUngrouped
          />
        ))}
      </div>

      {/* Group creation bar — appears when tabs are selected */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 p-3 rounded-lg border bg-muted/50 mt-2">
          <Layers className="size-4 text-muted-foreground shrink-0" />
          <Input
            placeholder="Group name..."
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreateGroup()}
            className="h-8 text-sm flex-1 md:max-w-xs"
          />
          <div className="flex items-center gap-4 ml-auto">
            <span className="text-xs font-medium text-muted-foreground">
              {selected.size} tab{selected.size !== 1 ? "s" : ""}
            </span>
            <div className="flex items-center gap-2 px-1">
              <Switch
                checked={isCompact}
                onCheckedChange={setIsCompact}
                className="scale-90"
              />
              <span className="text-[10px] font-medium text-muted-foreground whitespace-nowrap hidden sm:inline uppercase tracking-tight">
                Compact
              </span>
            </div>
            <ColorPicker value={groupColor} onChange={setGroupColor} />
            <Button
              size="sm"
              onClick={handleCreateGroup}
              disabled={isCreating}
              className="shadow-sm shadow-primary/20"
            >
              {isCreating ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Plus className="size-4 mr-1.5" />
              )}
              Create
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reusable "save as collection" dialog
// ---------------------------------------------------------------------------
function SaveCollectionDialog({
  open,
  defaultName,
  tabCount,
  isSaving,
  onConfirm,
  onClose,
}: {
  open: boolean;
  defaultName: string;
  tabCount: number;
  isSaving: boolean;
  onConfirm: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(defaultName);
  useEffect(() => setName(defaultName), [defaultName, open]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save as Collection</DialogTitle>
          <DialogDescription className="sr-only">
            Save {tabCount} tabs as a new collection of bookmarks.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-sm text-muted-foreground">
            {tabCount} tab{tabCount !== 1 ? "s" : ""} will be saved as bookmarks.
          </p>
          <Input
            placeholder="Collection name..."
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onConfirm(name)}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => onConfirm(name)}
            disabled={isSaving}
          >
            {isSaving ? (
              <Loader2 className="size-4 animate-spin mr-2" />
            ) : (
              <Save className="size-4 mr-2" />
            )}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------
export function TabsPanel() {
  const { openTabs, tabGroups, isLoading, loadTabs, saveWindowAsCollection } =
    useTabsStore();
  const [saveWindowOpen, setSaveWindowOpen] = useState(false);
  const [isSavingWindow, setIsSavingWindow] = useState(false);
  const [savedMsg, setSavedMsg] = useState(false);
  const [selectedTabIds, setSelectedTabIds] = useState<number[]>([]);
  const [isJoinDialogOpen, setIsJoinDialogOpen] = useState(false);

  const handleJoinRequest = (tabIds: number[]) => {
    setSelectedTabIds(tabIds);
    setIsJoinDialogOpen(true);
  };

  useEffect(() => {
    loadTabs();

    function onStorageChange(
      changes: { [key: string]: chrome.storage.StorageChange }, // Fix: Corrected typing for changes
      area: string
    ) {
      if (area === "local" && "tabmaster-tabs-changed" in changes) {
        loadTabs(true);
      }
    }
    chrome.storage.onChanged.addListener(onStorageChange);
    return () => chrome.storage.onChanged.removeListener(onStorageChange);
  }, []);

  // Split tabs into grouped (by groupId) and ungrouped
  const grouped = new Map<number, BrowserTab[]>();
  const ungrouped: BrowserTab[] = [];

  for (const tab of openTabs) {
    if (tab.groupId !== -1) {
      if (!grouped.has(tab.groupId)) grouped.set(tab.groupId, []);
      grouped.get(tab.groupId)!.push(tab);
    } else {
      ungrouped.push(tab);
    }
  }

  const handleSaveWindow = async (name: string) => {
    setIsSavingWindow(true);
    await saveWindowAsCollection(name);
    setIsSavingWindow(false);
    setSaveWindowOpen(false);
    setSavedMsg(true);
    setTimeout(() => setSavedMsg(false), 3000);
  };

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
            {savedMsg && (
              <span className="text-sm text-green-600 font-medium">Saved!</span>
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
            {/* Ungrouped tabs */}
            {ungrouped.length > 0 && (
              <UngroupedSection
                tabs={ungrouped}
                onJoinRequest={handleJoinRequest}
              />
            )}

            {/* Tab groups */}
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

      {/* Save window dialog */}
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
