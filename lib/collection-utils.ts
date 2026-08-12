interface SortableCollection {
  isDefault?: boolean;
  position: number;
}

export function compareActiveCollections(
  left: SortableCollection,
  right: SortableCollection,
): number {
  const leftIsDefault = left.isDefault === true;
  const rightIsDefault = right.isDefault === true;

  if (leftIsDefault !== rightIsDefault) {
    return leftIsDefault ? -1 : 1;
  }
  return right.position - left.position;
}
