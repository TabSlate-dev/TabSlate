import type * as React from "react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";

export interface MenuItemProps {
  onSelect?: (event: Event) => void;
  variant?: "default" | "destructive";
  className?: string;
  children: React.ReactNode;
}

/** Menu parts an entity's items render with, so one item list serves both the ⋯ menu and the right-click menu. */
export interface MenuPrimitives {
  Item: React.ComponentType<MenuItemProps>;
  Separator: React.ComponentType;
}

export const dropdownMenuPrimitives: MenuPrimitives = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
};

export const contextMenuPrimitives: MenuPrimitives = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
};
