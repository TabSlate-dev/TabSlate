import * as React from "react";
import { useDroppable } from "@dnd-kit/core";
import { 
  Pencil, 
  Check, 
  X, 
  Play, 
  Trash2, 
  MoreHorizontal, 
  Save, 
  BookmarkPlus,
  ExternalLink,
  BrushCleaning,
  FolderPlus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { FaviconImage } from "@/components/ui/favicon-image";
import { ColorPicker } from "@/components/ui/color-picker";
import { useGroupsStore, type SavedGroup, type GroupTab } from "@/store/groups-store";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { 
  DropdownMenu, 
  DropdownMenuContent, 
  DropdownMenuItem, 
  DropdownMenuSeparator, 
  DropdownMenuTrigger 
} from "@/components/ui/dropdown-menu";
import { GroupCardBase } from "@/components/dashboard/shared/group-card-base";
import { SaveCollectionDialog } from "@/components/dashboard/tabs-panel/save-collection-dialog";
import { CollectionDialog } from "@/components/dashboard/sidebar/collection-dialog";
import { generateId } from "@/lib/id";

interface DroppableGroupCardProps {
  group: SavedGroup;
  tabs: GroupTab[];
}

export function DroppableGroupCard({ group, tabs }: DroppableGroupCardProps) {
  const { isOver, setNodeRef } = useDroppable({
    id: `group-${group.id}`,
    data: { type: "saved-group", groupId: group.id },
  });

  const updateGroup = useGroupsStore(s => s.updateGroup);
  const deleteGroup = useGroupsStore(s => s.deleteGroup);
  const removeTabFromGroup = useGroupsStore(s => s.removeTabFromGroup);
  const openGroup = useGroupsStore(s => s.openGroup);
  const addBookmarks = useBookmarksStore(s => s.addBookmarks);

  const [expanded, setExpanded] = React.useState(true);
  const [editing, setEditing] = React.useState(false);
  const [nameVal, setNameVal] = React.useState(group.name);
  const [colorVal, setColorVal] = React.useState(group.color);
  const [saveDialogOpen, setSaveDialogOpen] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const [saveResult, setSaveResult] = React.useState<{ saved: number; skipped: number } | null>(null);
  const [savedTabIds, setSavedTabIds] = React.useState<Set<string>>(new Set());
  const [saveMenuOpenMap, setSaveMenuOpenMap] = React.useState<Record<string, boolean>>({});
  const [collectionDialogTab, setCollectionDialogTab] = React.useState<GroupTab | null>(null);

  const collections = useWorkspaceStore(s => s.collections);
  const activeWorkspaceId = useWorkspaceStore(s => s.activeWorkspaceId);
  const createCollection = useWorkspaceStore(s => s.createCollection);

  const activeCollections = React.useMemo(() => {
    return collections
      .filter((c) => c.workspaceId === activeWorkspaceId && !c.deletedAt && !c.archivedAt)
      .sort((a, b) => a.position - b.position);
  }, [collections, activeWorkspaceId]);

  const saveEdit = React.useCallback(() => {
    updateGroup(group.id, { name: nameVal, color: colorVal });
    setEditing(false);
  }, [updateGroup, group.id, nameVal, colorVal]);

  const cancelEdit = React.useCallback(() => {
    setNameVal(group.name);
    setColorVal(group.color);
    setEditing(false);
  }, [group.name, group.color]);

  const handleSaveGroup = React.useCallback(async (name: string) => {
    setIsSaving(true);
    const { activeWorkspaceId, createCollection } = useWorkspaceStore.getState();
    const collection = createCollection(activeWorkspaceId, name, "folder");
    
    const newBookmarks = tabs.map(t => ({
      id: generateId(),
      title: t.title,
      url: t.url,
      favicon: t.favicon,
      collectionId: collection.id,
      description: "",
      tags: [],
      createdAt: new Date().toISOString(),
      isFavorite: false,
      seq: 0,
    }));

    addBookmarks(newBookmarks);
    setIsSaving(false);
    setSaveDialogOpen(false);
    setSaveResult({ saved: newBookmarks.length, skipped: 0 });
    setTimeout(() => setSaveResult(null), 3000);
  }, [tabs, addBookmarks]);

  const handleSaveTab = React.useCallback((tab: GroupTab, collectionId: string) => {
    addBookmarks([{
      id: generateId(),
      title: tab.title,
      url: tab.url,
      favicon: tab.favicon,
      collectionId,
      description: "",
      tags: [],
      createdAt: new Date().toISOString(),
      isFavorite: false,
      seq: 0,
    }]);
    setSavedTabIds(prev => new Set(prev).add(tab.id));
    setTimeout(() => {
      setSavedTabIds(prev => {
        const next = new Set(prev);
        next.delete(tab.id);
        return next;
      });
    }, 2000);
  }, [addBookmarks]);

  const titleSlot = editing ? (
    <div className="flex flex-col gap-2 py-1">
      <Input
        value={nameVal}
        onChange={(e) => setNameVal(e.target.value)}
        className="h-7 text-sm"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter") { saveEdit(); }
          if (e.key === "Escape") { cancelEdit(); }
        }}
      />
      <ColorPicker value={colorVal} onChange={setColorVal} size="sm" />
    </div>
  ) : (
    <span 
      className="text-sm font-semibold truncate block cursor-pointer hover:text-primary transition-colors"
      onClick={() => setEditing(true)}
    >
      {group.name}
    </span>
  );

  const headerActions = (
    <div className="flex items-center gap-1">
      {saveResult && (
        <span className="text-[10px] bg-green-500/10 text-green-600 px-1.5 py-0.5 rounded-full animate-in fade-in zoom-in duration-300">
          Saved {saveResult.saved}
        </span>
      )}
      
      {editing ? (
        <>
          <Button variant="ghost" size="icon-xs" onClick={saveEdit} className="size-6">
            <Check className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-xs" onClick={cancelEdit} className="size-6">
            <X className="size-3.5" />
          </Button>
        </>
      ) : (
        <>
          <ColorPicker
            value={group.color}
            onChange={(c) => updateGroup(group.id, { color: c })}
            size="sm"
          />

          <div className="flex items-center gap-1.5 px-2 border-l border-r border-border/50">
            <Switch
              checked={group.isCompact}
              onCheckedChange={(checked) => updateGroup(group.id, { isCompact: checked })}
              className="scale-75"
              title="Toggle Compact"
            />
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-tight">
              Compact
            </span>
          </div>

          <Button 
            variant="ghost" 
            size="icon-xs" 
            onClick={() => openGroup(group.id)} 
            className="size-6 hover:text-green-500"
            title="Open group in Chrome"
          >
            <Play className="size-3.5" />
          </Button>
          
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" className="size-6">
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setEditing(true)}>
                <Pencil className="size-4 mr-2" />
                Rename Group
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setSaveDialogOpen(true)}>
                <Save className="size-4 mr-2" />
                Save as Collection
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive focus:bg-destructive/10 cursor-pointer"
                onClick={() => deleteGroup(group.id)}
              >
                <Trash2 className="size-4 mr-2" />
                Delete Group
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
  );

  return (
    <GroupCardBase
      id={group.id}
      name={group.name}
      color={group.color}
      expanded={expanded}
      onToggleExpand={setExpanded}
      tabCount={tabs.length}
      titleSlot={titleSlot}
      headerActions={headerActions}
      dropRef={setNodeRef}
      isOver={isOver}
    >
      <div className="space-y-0.5 mt-1">
        {tabs.length === 0 && (
          <p className="py-4 text-[11px] text-muted-foreground text-center">
            Drop tabs here to save
          </p>
        )}
        {tabs
          .sort((a, b) => a.position - b.position)
          .map((t) => (
            <div
              key={t.id}
              className="group/tab flex items-center gap-2.5 px-2 py-1.5 rounded-md border border-transparent hover:border-border hover:bg-muted/40 transition-all"
            >
              <FaviconImage src={t.favicon} className="size-4 shrink-0 rounded-sm" />
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-medium truncate leading-tight group-hover/tab:text-primary transition-colors">
                  {t.title}
                </p>
                <p className="text-[10px] text-muted-foreground truncate opacity-70">
                  {new URL(t.url).hostname}
                </p>
              </div>
              
              <div className="flex items-center gap-0.5 opacity-0 group-hover/tab:opacity-100 transition-opacity">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => removeTabFromGroup(t.id)}
                  className="size-6 text-destructive hover:bg-destructive/10"
                  title="Remove from group"
                >
                  <BrushCleaning className="size-3" />
                </Button>
                <DropdownMenu
                  open={saveMenuOpenMap[t.id] ?? false}
                  onOpenChange={(open) => setSaveMenuOpenMap(prev => ({ ...prev, [t.id]: open }))}
                >
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={(e) => e.stopPropagation()}
                      title={savedTabIds.has(t.id) ? "Saved!" : "Save to collection"}
                      className={cn("size-6 text-muted-foreground", savedTabIds.has(t.id) && "text-green-600 hover:text-green-600")}
                    >
                      {savedTabIds.has(t.id) ? <Check className="size-3" /> : <BookmarkPlus className="size-3" />}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48 max-h-64 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                    {activeCollections.map((c) => (
                      <DropdownMenuItem
                        key={c.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSaveMenuOpenMap(prev => ({ ...prev, [t.id]: false }));
                          handleSaveTab(t, c.id);
                        }}
                      >
                        <span className="truncate">{c.name}</span>
                      </DropdownMenuItem>
                    ))}
                    {activeCollections.length > 0 && <DropdownMenuSeparator />}
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation();
                        setSaveMenuOpenMap(prev => ({ ...prev, [t.id]: false }));
                        setCollectionDialogTab(t);
                      }}
                    >
                      <FolderPlus className="size-3.5 mr-2" />
                      New Collection...
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => window.open(t.url, "_blank")}
                  className="size-6 text-muted-foreground hover:text-foreground"
                  title="Open in new tab"
                >
                  <ExternalLink className="size-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => removeTabFromGroup(t.id)}
                  className="size-6 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                  title="Delete from list"
                >
                  <X className="size-3" />
                </Button>
              </div>
            </div>
          ))}
      </div>

      <SaveCollectionDialog
        open={saveDialogOpen}
        defaultName={group.name}
        tabCount={tabs.length}
        isSaving={isSaving}
        onConfirm={handleSaveGroup}
        onClose={() => setSaveDialogOpen(false)}
      />

      {collectionDialogTab && (
        <CollectionDialog
          open={!!collectionDialogTab}
          onOpenChange={(open) => { if (!open) { setCollectionDialogTab(null); } }}
          onSubmit={(name, icon) => {
            const newCol = createCollection(activeWorkspaceId, name, icon);
            handleSaveTab(collectionDialogTab, newCol.id);
            setCollectionDialogTab(null);
          }}
        />
      )}
    </GroupCardBase>
  );
}
