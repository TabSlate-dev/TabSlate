import { Archive, ExternalLink, Pencil, Tag as TagIcon, Trash2 } from "lucide-react";
import { useTranslation } from "@/hooks/use-translation";
import type { MenuPrimitives } from "./menu-primitives";

interface BookmarkMenuItemsProps {
  menu: MenuPrimitives;
  onOpenSmart: () => void;
  onOpenNewTab: () => void;
  onEdit: () => void;
  onAddTags: () => void;
  onArchive: () => void;
  onDelete: () => void;
}

export function BookmarkMenuItems({
  menu,
  onOpenSmart,
  onOpenNewTab,
  onEdit,
  onAddTags,
  onArchive,
  onDelete,
}: BookmarkMenuItemsProps) {
  const { t } = useTranslation();
  const { Item, Separator } = menu;
  return (
    <>
      <Item onSelect={onOpenSmart}>
        <ExternalLink className="size-4" />
        {t("bookmarkCard_openSmart")}
      </Item>
      <Item onSelect={onOpenNewTab}>
        <ExternalLink className="size-4" />
        {t("bookmarkCard_openNewTab")}
      </Item>
      <Item onSelect={onEdit}>
        <Pencil className="size-4" />
        {t("bookmarkCard_edit")}
      </Item>
      <Item onSelect={onAddTags}>
        <TagIcon className="size-4" />
        {t("bookmarkCard_addTags")}
      </Item>
      <Separator />
      <Item onSelect={onArchive}>
        <Archive className="size-4" />
        {t("bookmarkCard_archive")}
      </Item>
      <Item variant="destructive" onSelect={onDelete}>
        <Trash2 className="size-4" />
        {t("bookmarkCard_delete")}
      </Item>
    </>
  );
}
