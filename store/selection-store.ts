import { create } from "zustand";

export type GroupSelectionState = "all" | "some" | "none";

interface SelectionState {
  /** Replaced, never mutated, on every change. */
  selectedIds: ReadonlySet<string>;
  /** Where the next Shift+click range starts. */
  anchorId: string | null;
  /** Adds or removes one bookmark and makes it the anchor. */
  toggle: (id: string) => void;
  /**
   * Adds every bookmark from the anchor to `toId` in `orderedIds`, inclusive,
   * and keeps the anchor. Without a usable anchor it toggles `toId`.
   */
  selectRange: (orderedIds: readonly string[], toId: string) => void;
  /** Selects or deselects many bookmarks without moving the anchor. */
  setMany: (ids: readonly string[], selected: boolean) => void;
  /** Keeps only the bookmarks in `ids`, e.g. the ones still in the view. */
  retain: (ids: readonly string[]) => void;
  clear: () => void;
}

const NONE: ReadonlySet<string> = new Set<string>();

function toggled(selectedIds: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selectedIds);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

/** The bookmarks selected in the current view. Never persisted. */
export const useSelectionStore = create<SelectionState>()((set) => ({
  selectedIds: NONE,
  anchorId: null,

  toggle: (id) => set((state) => ({ selectedIds: toggled(state.selectedIds, id), anchorId: id })),

  selectRange: (orderedIds, toId) => set((state) => {
    const from = state.anchorId === null ? -1 : orderedIds.indexOf(state.anchorId);
    const to = orderedIds.indexOf(toId);
    if (from === -1 || to === -1) {
      return { selectedIds: toggled(state.selectedIds, toId), anchorId: toId };
    }
    const next = new Set(state.selectedIds);
    for (let index = Math.min(from, to); index <= Math.max(from, to); index += 1) {
      next.add(orderedIds[index]);
    }
    return { selectedIds: next };
  }),

  setMany: (ids, selected) => set((state) => {
    const next = new Set(state.selectedIds);
    for (const id of ids) {
      if (selected) {
        next.add(id);
      } else {
        next.delete(id);
      }
    }
    return { selectedIds: next };
  }),

  // Runs whenever a view's list changes, so it must not notify when nothing drops out.
  retain: (ids) => set((state) => {
    const keep = new Set(ids);
    const kept = [...state.selectedIds].filter((id) => keep.has(id));
    if (kept.length === state.selectedIds.size) {
      return state;
    }
    return {
      selectedIds: new Set(kept),
      anchorId: state.anchorId !== null && keep.has(state.anchorId) ? state.anchorId : null,
    };
  }),

  clear: () => set((state) => (
    state.selectedIds.size === 0 && state.anchorId === null ? state : { selectedIds: NONE, anchorId: null }
  )),
}));

/** Whether all, some, or none of a group's bookmarks are selected; "none" for an empty group. */
export function selectionStateOf(selectedIds: ReadonlySet<string>, ids: readonly string[]): GroupSelectionState {
  let count = 0;
  for (const id of ids) {
    if (selectedIds.has(id)) {
      count += 1;
    }
  }
  if (count === 0) {
    return "none";
  }
  return count === ids.length ? "all" : "some";
}
