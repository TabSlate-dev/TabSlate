import { Archive, Pencil, Trash2 } from "lucide-react";
import type { Collection } from "@/lib/types";
import { useTranslation } from "@/hooks/use-translation";
import type { MenuPrimitives } from "./menu-primitives";

interface CollectionMenuItemsProps {
  menu: MenuPrimitives;
  collection: Collection;
  onEdit: () => void;
  onArchive: () => void;
  onDelete: () => void;
}

/** The default collection can be edited but never archived or deleted. */
export function CollectionMenuItems({ menu, collection, onEdit, onArchive, onDelete }: CollectionMenuItemsProps) {
  const { t } = useTranslation();
  const { Item, Separator } = menu;
  return (
    <>
      <Item onSelect={onEdit}>
        <Pencil className="size-4" />
        {t("collectionMenu_edit")}
      </Item>
      {!collection.isDefault && (
        <>
          <Item onSelect={onArchive}>
            <Archive className="size-4" />
            {t("sidebar_archiveCollection")}
          </Item>
          <Separator />
          <Item variant="destructive" onSelect={onDelete}>
            <Trash2 className="size-4" />
            {t("sidebar_deleteCollection")}
          </Item>
        </>
      )}
    </>
  );
}
