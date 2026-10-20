import * as React from "react";
import { Check, FolderPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CollectionDialog } from "@/components/dashboard/sidebar/collection-dialog";
import { FilterableList } from "@/components/dashboard/shared/filterable-list";
import { useTranslation } from "@/hooks/use-translation";
import { getActiveWorkspaceCollections, isActiveWorkspace } from "@/lib/workspace-visibility";
import { useWorkspaceStore } from "@/store/workspace-store";

interface CollectionPickerProps {
  /** The collection shown as chosen; null when nothing is chosen, as in the bulk Move menu. */
  selectedId: string | null;
  onSelect: (collectionId: string) => void;
  /** The element that opens the picker, e.g. a button. */
  children: React.ReactElement;
  align?: "start" | "center" | "end";
}

/**
 * A searchable list of the active workspace's active collections (default
 * first, then newest) with "New collection…", which creates a collection in
 * the active workspace and selects it.
 */
export function CollectionPicker({ selectedId, onSelect, children, align = "start" }: CollectionPickerProps) {
  const { t } = useTranslation();
  const collections = useWorkspaceStore((s) => s.collections);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const createCollection = useWorkspaceStore((s) => s.createCollection);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [newCollectionOpen, setNewCollectionOpen] = React.useState(false);

  const items = React.useMemo(
    () => getActiveWorkspaceCollections(activeWorkspaceId, workspaces, collections)
      .map((collection) => ({ id: collection.id, label: collection.name })),
    [activeWorkspaceId, workspaces, collections],
  );

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery("");
    }
  };

  const handleActivate = (item: { id: string }) => {
    handleOpenChange(false);
    onSelect(item.id);
  };

  const handleNewCollection = (name: string, icon: string) => {
    const state = useWorkspaceStore.getState();
    const activeWorkspace = state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId);
    if (!isActiveWorkspace(activeWorkspace)) {
      return;
    }
    const collection = createCollection(state.activeWorkspaceId, name, icon);
    // An empty ID means the quota blocked it; the quota alert says so.
    if (collection.id) {
      onSelect(collection.id);
    }
  };

  return (
    <>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>{children}</PopoverTrigger>
        <PopoverContent align={align} className="w-64 p-2">
          <FilterableList
            items={items}
            query={query}
            onQueryChange={setQuery}
            onActivate={handleActivate}
            renderItem={(item) => (
              <>
                <span className="flex-1 truncate">{item.label}</span>
                {item.id === selectedId && <Check className="size-3.5 shrink-0" />}
              </>
            )}
            placeholder={t("collectionPicker_filterPlaceholder")}
            emptyText={t("collectionPicker_empty")}
            autoFocus
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-1 w-full justify-start"
            onClick={() => {
              handleOpenChange(false);
              setNewCollectionOpen(true);
            }}
          >
            <FolderPlus className="size-3.5" />
            {t("groupsPanel_newCollection")}
          </Button>
        </PopoverContent>
      </Popover>
      <CollectionDialog open={newCollectionOpen} onOpenChange={setNewCollectionOpen} onSubmit={handleNewCollection} />
    </>
  );
}
