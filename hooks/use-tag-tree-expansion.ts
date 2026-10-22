import * as React from "react";
import { tagAncestors, type TagTree } from "@/lib/tag-tree";
import { idbGet, idbPut } from "@/lib/idb";

interface TagTreeExpandedRecord {
  key: string;
  value: unknown;
}

export function useTagTreeExpansion(
  tree: TagTree,
  selectedIds: readonly string[],
  query: string,
): { expandedIds: ReadonlySet<string>; toggle: (id: string) => void } {
  const [manualExpanded, setManualExpanded] = React.useState<ReadonlySet<string>>(() => new Set());
  const userModificationsRef = React.useRef<Map<string, boolean>>(new Map());

  React.useEffect(() => {
    let active = true;
    idbGet<TagTreeExpandedRecord>("kv", "tag-tree-expanded")
      .then((entry) => {
        if (!active) {
          return;
        }
        const loaded = Array.isArray(entry?.value)
          ? entry.value.filter((id): id is string => typeof id === "string")
          : [];
        setManualExpanded((_prev) => {
          const next = new Set<string>(loaded);
          for (const [id, expanded] of userModificationsRef.current) {
            if (expanded) {
              next.add(id);
            } else {
              next.delete(id);
            }
          }
          return next;
        });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const toggle = React.useCallback((id: string) => {
    setManualExpanded((prev) => {
      const next = new Set(prev);
      const willBeExpanded = !next.has(id);
      if (willBeExpanded) {
        next.add(id);
      } else {
        next.delete(id);
      }
      userModificationsRef.current.set(id, willBeExpanded);
      void idbPut("kv", { key: "tag-tree-expanded", value: Array.from(next) }).catch(() => {});
      return next;
    });
  }, []);

  const expandedIds = React.useMemo(() => {
    const result = new Set<string>(manualExpanded);
    for (const selectedId of selectedIds) {
      for (const ancestor of tagAncestors(tree, selectedId)) {
        result.add(ancestor);
      }
    }
    const needle = query.trim().toLowerCase();
    if (needle) {
      for (const [id, tag] of tree.tagsById) {
        if (tag.name.toLowerCase().includes(needle)) {
          for (const ancestor of tagAncestors(tree, id)) {
            result.add(ancestor);
          }
        }
      }
    }
    return result;
  }, [manualExpanded, tree, selectedIds, query]);

  return { expandedIds, toggle };
}
