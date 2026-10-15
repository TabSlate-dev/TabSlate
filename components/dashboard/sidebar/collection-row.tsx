import * as React from "react";
import { Link } from "react-router-dom";
import {
  Bookmark,
  BookOpen,
  ChevronRight,
  Code,
  Folder,
  Globe,
  Heart,
  Inbox,
  MoreHorizontal,
  Palette,
  Sparkles,
  Star,
  Wrench,
} from "lucide-react";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/store/workspace-store";
import { useTranslation } from "@/hooks/use-translation";
import type { Collection } from "@/lib/types";
import { CollectionMenuItems } from "@/components/dashboard/shared/collection-menu-items";
import { contextMenuPrimitives, dropdownMenuPrimitives } from "@/components/dashboard/shared/menu-primitives";
import { CollectionDialog } from "./collection-dialog";

const ICON_MAP: Record<string, React.ElementType> = {
  folder: Folder,
  bookmark: Bookmark,
  code: Code,
  palette: Palette,
  wrench: Wrench,
  "book-open": BookOpen,
  sparkles: Sparkles,
  star: Star,
  heart: Heart,
  globe: Globe,
  inbox: Inbox,
};

function CollectionIcon({ icon }: { icon: string }) {
  const Icon = ICON_MAP[icon] ?? Folder;
  return <Icon className="size-4" />;
}

interface SidebarCollectionRowProps {
  collection: Collection;
  count: number;
  isActive: boolean;
  isHighlighted: boolean;
  onSelect: (collectionId: string) => void;
}

export function SidebarCollectionRow({ collection, count, isActive, isHighlighted, onSelect }: SidebarCollectionRowProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const updateCollection = useWorkspaceStore((s) => s.updateCollection);
  const archiveCollection = useWorkspaceStore((s) => s.archiveCollection);
  const deleteCollection = useWorkspaceStore((s) => s.deleteCollection);

  const handleEdit = React.useCallback(() => setEditing(true), []);
  const handleArchive = React.useCallback(() => archiveCollection(collection.id), [archiveCollection, collection.id]);
  const handleDelete = React.useCallback(() => deleteCollection(collection.id), [deleteCollection, collection.id]);

  return (
    <SidebarMenuItem>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <SidebarMenuButton
            asChild
            isActive={isActive}
            className={cn(
              "h-9 group/col transition-all",
              isHighlighted && "ring-2 ring-inset ring-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-500",
            )}
          >
            <Link to="/" onClick={() => onSelect(collection.id)}>
              <CollectionIcon icon={collection.icon} />
              <span className="flex-1 text-sm truncate">{collection.name}</span>
              <div className="flex items-center">
                <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={t("collectionMenu_more")}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      className={cn(
                        "flex items-center justify-center overflow-hidden text-muted-foreground hover:text-foreground transition-all duration-300 ease-out",
                        menuOpen
                          ? "w-4 mr-1 opacity-100 translate-x-0"
                          : "opacity-0 -translate-x-2 w-0 group-hover/col:w-4 group-hover/col:mr-1 group-hover/col:opacity-100 group-hover/col:translate-x-0",
                      )}
                    >
                      <MoreHorizontal className="size-3 shrink-0" />
                    </button>
                  </DropdownMenuTrigger>
                  {/* The menu renders in a portal, but React still bubbles its clicks to the
                      row's Link; stop them so an action neither selects the collection nor navigates. */}
                  <DropdownMenuContent align="end" side="right" onClick={(event) => event.stopPropagation()}>
                    <CollectionMenuItems
                      menu={dropdownMenuPrimitives}
                      collection={collection}
                      onEdit={handleEdit}
                      onArchive={handleArchive}
                      onDelete={handleDelete}
                    />
                  </DropdownMenuContent>
                </DropdownMenu>
                <span className="text-muted-foreground text-xs shrink-0">{count}</span>
              </div>
              {isActive && <ChevronRight className="size-3.5 text-muted-foreground opacity-60 shrink-0 ml-1" />}
            </Link>
          </SidebarMenuButton>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <CollectionMenuItems
            menu={contextMenuPrimitives}
            collection={collection}
            onEdit={handleEdit}
            onArchive={handleArchive}
            onDelete={handleDelete}
          />
        </ContextMenuContent>
      </ContextMenu>
      {editing && (
        <CollectionDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setEditing(false);
            }
          }}
          initial={collection}
          onSubmit={(name, icon) => updateCollection(collection.id, { name, icon })}
        />
      )}
    </SidebarMenuItem>
  );
}
