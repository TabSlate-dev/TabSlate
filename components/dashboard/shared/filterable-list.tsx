import * as React from "react";
import { Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/hooks/use-translation";
import { cn } from "@/lib/utils";

export interface FilterableListItem {
  id: string;
  label: string;
}

export interface FilterableListCreate {
  /** Whether the trimmed, non-empty name may become a new item. */
  canCreate: (name: string) => boolean;
  onCreate: (name: string) => void;
}

interface FilterableListProps<T extends FilterableListItem> {
  items: readonly T[];
  query: string;
  onQueryChange: (query: string) => void;
  onActivate: (item: T) => void;
  /** Offers "Create «name»" when no item has the typed name and `canCreate` allows it. */
  create?: FilterableListCreate;
  /** Row content; the label by default. */
  renderItem?: (item: T) => React.ReactNode;
  /** Extra ARIA state for a row, e.g. aria-checked in a check list. */
  itemAria?: (item: T) => React.AriaAttributes;
  matchesQuery?: (item: T, query: string) => boolean;
  hasExactMatch?: (query: string) => boolean;
  placeholder: string;
  emptyText: string;
  /** Hides the list, e.g. while a picker's field is not focused. */
  listHidden?: boolean;
  inputId?: string;
  autoFocus?: boolean;
  /** Runs before the list's own key handling; preventDefault takes the key over. */
  onInputKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onInputFocus?: () => void;
  onInputBlur?: () => void;
  className?: string;
  listClassName?: string;
}

type Row<T> = { kind: "item"; item: T } | { kind: "create"; name: string };

/**
 * A filter field over a listbox. Arrow keys move the highlight; Enter
 * activates it once the user typed or moved, so Enter in an untouched field
 * still reaches the surrounding form. Cmd/Ctrl+Enter is always left alone.
 */
export function FilterableList<T extends FilterableListItem>({
  items,
  query,
  onQueryChange,
  onActivate,
  create,
  renderItem,
  itemAria,
  matchesQuery,
  hasExactMatch,
  placeholder,
  emptyText,
  listHidden = false,
  inputId,
  autoFocus,
  onInputKeyDown,
  onInputFocus,
  onInputBlur,
  className,
  listClassName,
}: FilterableListProps<T>) {
  const { t } = useTranslation();
  const listId = React.useId();
  const listRef = React.useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [navigated, setNavigated] = React.useState(false);

  const rows = React.useMemo<Row<T>[]>(() => {
    const name = query.trim();
    const needle = name.toLowerCase();
    const matches = needle
      ? items.filter((item) => (matchesQuery ? matchesQuery(item, query) : item.label.toLowerCase().includes(needle)))
      : items;
    const result = matches.map<Row<T>>((item) => ({ kind: "item", item }));
    const exists = hasExactMatch
      ? hasExactMatch(query)
      : items.some((item) => item.label.trim().toLowerCase() === needle);
    if (create && name && !exists && create.canCreate(name)) {
      result.push({ kind: "create", name });
    }
    return result;
  }, [items, query, create, matchesQuery, hasExactMatch]);

  React.useEffect(() => {
    setActiveIndex(0);
    setNavigated(false);
  }, [query]);

  const highlighted = Math.min(activeIndex, rows.length - 1);

  React.useEffect(() => {
    if (listHidden) {
      return;
    }
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [highlighted, rows, listHidden]);

  const handleActivateRow = (row: Row<T>) => {
    if (row.kind === "item") {
      onActivate(row.item);
    } else {
      create?.onCreate(row.name);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    onInputKeyDown?.(event);
    if (event.defaultPrevented || listHidden) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setNavigated(true);
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex(Math.max(0, Math.min(highlighted + step, rows.length - 1)));
      return;
    }
    if (event.key !== "Enter" || event.metaKey || event.ctrlKey) {
      return;
    }
    const row = rows[highlighted];
    const typed = query.trim() !== "";
    if (row && (typed || navigated)) {
      event.preventDefault();
      handleActivateRow(row);
    } else if (typed) {
      event.preventDefault();
    }
  };

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <Input
        id={inputId}
        role="combobox"
        aria-expanded={!listHidden}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={!listHidden && rows[highlighted] ? `${listId}-${highlighted}` : undefined}
        value={query}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={onInputFocus}
        onBlur={onInputBlur}
        className="h-8"
      />
      {!listHidden && (
        <div ref={listRef} id={listId} role="listbox" className={cn("max-h-56 overflow-y-auto", listClassName)}>
          {rows.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{emptyText}</p>
          ) : (
            rows.map((row, index) => (
              <div
                key={row.kind === "item" ? row.item.id : "create"}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === highlighted}
                {...(row.kind === "item" ? itemAria?.(row.item) : undefined)}
                // Keep focus in the field, so a click does not close a picker that hides on blur.
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setActiveIndex(index)}
                onClick={() => handleActivateRow(row)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
                  index === highlighted && "bg-accent text-accent-foreground",
                )}
              >
                {row.kind === "item" ? (
                  renderItem ? renderItem(row.item) : <span className="truncate">{row.item.label}</span>
                ) : (
                  <>
                    <Plus className="size-3.5 shrink-0" />
                    <span className="truncate">{t("filterableList_create", [row.name])}</span>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
