interface SortableCollection {
  isDefault?: boolean;
  position: number;
}

export function compareActiveCollections(
  left: SortableCollection,
  right: SortableCollection,
): number {
  if (left.isDefault) {
    return -1;
  }
  if (right.isDefault) {
    return 1;
  }
  return right.position - left.position;
}
