interface SortableCollection {
  isDefault?: boolean;
  position: number;
}

export function compareActiveCollections(
  left: SortableCollection,
  right: SortableCollection,
): number {
  if (left.isDefault !== right.isDefault) {
    return left.isDefault ? -1 : 1;
  }
  return right.position - left.position;
}
