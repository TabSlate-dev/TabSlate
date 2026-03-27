import { useEffect, useRef, useState } from "react";
import { useTabsStore } from "@/store/tabs-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { storageService } from "@/lib/storage";

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
interface TabRowProps {
  tab: BrowserTab;
  selected?: boolean;
  onSelect?: (checked: boolean) => void;
  showCheckbox?: boolean;
}

function TabRow({ tab, selected, onSelect, showCheckbox }: TabRowProps) {
  const { closeTab, focusTab } = useTabsStore();
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    await storageService.addBookmark({
      title: tab.title,
      url: tab.url,
      favicon: tab.favIconUrl,
      collectionId: "all",
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div
      className={cn(
        "group flex items-center gap-2.5 px-3 py-2 rounded-md hover:bg-accent/50 transition-colors",
        tab.active && "bg-blue-50/60 dark:bg-blue-950/20"
      )}
    >
      {showCheckbox && (
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => onSelect?.(e.target.checked)}
          className="size-3.5 rounded accent-primary shrink-0"
          onClick={(e) => e.stopPropagation()}
        />
      )}

      {/* Favicon */}
      <div className="size-6 rounded bg-muted flex items-center justify-center shrink-0 overflow-hidden">
        {tab.favIconUrl ? (
          <img
            src={tab.favIconUrl}
            alt=""
            className="size-4"
            onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
          />
        ) : (
          <Bookmark className="size-3 text-muted-foreground" />
        )}
      </div>

      {/* Title */}
      <button
        className="flex-1 min-w-0 text-left"
        onClick={() => focusTab(tab.id, tab.windowId)}
        title={tab.url}
      >
        <p className={cn("text-sm truncate", tab.active && "font-medium")}>
          {tab.title}
        </p>
      </button>

      {/* Hover actions */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={handleSave}
          title={saved ? "Saved!" : "Save bookmark"}
          className={cn("size-6", saved && "text-green-600")}
        >
          {saved ? <Check className="size-3" /> : <Bookmark className="size-3" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => window.open(tab.url, "_blank")}
          title="Open in new tab"
          className="size-6"
        >
          <ExternalLink className="size-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => closeTab(tab.id)}
          title="Close tab"
          className="size-6 hover:text-destructive"
        >
          <X className="size-3" />
        </Button>
      </div>
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

function GroupCard({ group, tabs }: GroupCardProps) {
  const { updateGroup, dissolveGroup, saveGroupAsCollection } = useTabsStore();
  const [expanded, setExpanded] = useState(true);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(group.title);
  const [isSaving, setIsSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

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
          <input
            ref={nameRef}
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onBlur={handleNameCommit}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleNameCommit();
              if (e.key === "Escape") {
                setNameInput(group.title);
                setEditingName(false);
              }
            }}
            className="flex-1 text-sm font-medium bg-transparent border-b border-primary outline-none min-w-0"
            autoFocus
          />
        ) : (
          <button
            onClick={() => setEditingName(true)}
            className="flex-1 text-sm font-medium text-left truncate hover:opacity-70 transition-opacity"
            title="Click to rename"
          >
            {group.title || "Unnamed group"}
          </button>
        )}

        <span className="text-xs text-muted-foreground shrink-0">
          {tabs.length} tab{tabs.length !== 1 ? "s" : ""}
        </span>

        {/* Color picker */}
        <div className="flex items-center gap-1 shrink-0">
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

      {/* Tabs */}
      {expanded && (
        <div className="px-2 pb-2 pt-1 bg-card/50 space-y-0.5">
          {tabs.map((tab) => (
            <TabRow key={tab.id} tab={tab} />
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
function UngroupedSection({ tabs }: { tabs: BrowserTab[] }) {
  const { createGroup } = useTabsStore();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [groupName, setGroupName] = useState("");
  const [groupColor, setGroupColor] = useState<TabGroupColor>("blue");
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
    await createGroup([...selected], groupName.trim() || "New Group", groupColor);
    setSelected(new Set());
    setGroupName("");
    setIsCreating(false);
  };

  if (tabs.length === 0) return null;

  return (
    <div className="space-y-1">
      <p className="text-[10px] font-semibold tracking-wider text-muted-foreground px-1 uppercase">
        Ungrouped · {tabs.length}
      </p>

      <div className="rounded-lg border bg-card divide-y divide-border/50">
        {tabs.map((tab) => (
          <TabRow
            key={tab.id}
            tab={tab}
            showCheckbox
            selected={selected.has(tab.id)}
            onSelect={(checked) => toggleSelect(tab.id, checked)}
          />
        ))}
      </div>

      {/* Group creation bar — appears when tabs are selected */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 p-3 rounded-lg border bg-muted/50 mt-2">
          <Layers className="size-4 text-muted-foreground shrink-0" />
          <span className="text-sm text-muted-foreground shrink-0">
            Group {selected.size}
          </span>
          <Input
            placeholder="Group name..."
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreateGroup()}
            className="h-7 text-sm flex-1"
          />
          <ColorPicker value={groupColor} onChange={setGroupColor} />
          <Button
            size="sm"
            className="h-7 shrink-0"
            onClick={handleCreateGroup}
            disabled={isCreating}
          >
            {isCreating ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              "Create"
            )}
          </Button>
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
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Save as Collection</DialogTitle>
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
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => onConfirm(name)}
            disabled={!name.trim() || isSaving}
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

  useEffect(() => {
    loadTabs();

    function onStorageChange(
      changes: { [key: string]: chrome.storage.StorageChange }, // Fix: Corrected typing for changes
      area: string
    ) {
      if (area === "local" && "tabmaster-tabs-changed" in changes) {
        loadTabs();
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
              onClick={loadTabs}
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
          <div className="space-y-5">
            {/* Tab groups */}
            {tabGroups.length > 0 && (
              <div className="space-y-2">
                <p className="text-[10px] font-semibold tracking-wider text-muted-foreground px-1 uppercase">
                  Groups · {tabGroups.length}
                </p>
                {tabGroups.map((group) => (
                  <GroupCard
                    key={group.id}
                    group={group}
                    tabs={grouped.get(group.id) ?? []}
                  />
                ))}
              </div>
            )}

            {/* Ungrouped tabs */}
            <UngroupedSection tabs={ungrouped} />
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
    </div>
  );
}
