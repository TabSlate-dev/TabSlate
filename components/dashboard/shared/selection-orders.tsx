import * as React from "react";

export interface SelectionOrders {
  /** Every bookmark the view lists, in display order, including those in collapsed groups. */
  viewOrder: readonly string[];
  /** The view order without collapsed groups: what Shift+click and Select all use. */
  onScreenOrder: readonly string[];
}

const SelectionOrdersContext = React.createContext<React.RefObject<SelectionOrders> | null>(null);

interface SelectionOrdersProviderProps extends SelectionOrders {
  children: React.ReactNode;
}

/**
 * Makes a view's bookmarks selectable. The context value is a ref that never
 * changes, so a new list does not re-render every card; cards read the
 * orders in their event handlers.
 */
export function SelectionOrdersProvider({ viewOrder, onScreenOrder, children }: SelectionOrdersProviderProps) {
  const ordersRef = React.useRef<SelectionOrders>({ viewOrder, onScreenOrder });
  React.useLayoutEffect(() => {
    ordersRef.current = { viewOrder, onScreenOrder };
  }, [viewOrder, onScreenOrder]);
  return <SelectionOrdersContext.Provider value={ordersRef}>{children}</SelectionOrdersContext.Provider>;
}

/** The enclosing view's orders, or null outside a selectable view. */
export function useSelectionOrders(): React.RefObject<SelectionOrders> | null {
  return React.useContext(SelectionOrdersContext);
}
