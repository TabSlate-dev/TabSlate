const SIDEBAR_COLLECTION_PREFIX = "sidebar-collection-";
const CONTENT_COLLECTION_PREFIX = "content-collection-";

/**
 * Build the drop id for a Collection band in the content list.
 *
 * The virtualizer renders a Collection's header and each of its bookmark rows
 * as separate absolutely-positioned nodes, so covering the whole band takes one
 * droppable per node. `suffix` keeps those ids unique while still naming the
 * same Collection; Collection ids are UUIDs, so "#" cannot collide with one.
 */
export function contentCollectionDropId(collectionId: string, suffix?: string) {
  return `${CONTENT_COLLECTION_PREFIX}${collectionId}${suffix === undefined ? "" : `#${suffix}`}`;
}

export function isCollectionDropId(dropId: string) {
  return dropId.startsWith(SIDEBAR_COLLECTION_PREFIX)
    || dropId.startsWith(CONTENT_COLLECTION_PREFIX);
}

export function parseCollectionDropId(dropId: string) {
  const raw = dropId.startsWith(SIDEBAR_COLLECTION_PREFIX)
    ? dropId.slice(SIDEBAR_COLLECTION_PREFIX.length)
    : dropId.slice(CONTENT_COLLECTION_PREFIX.length);
  return raw.split("#")[0];
}

const SAVED_GROUP_PREFIX = "saved-group-";

/** Drop id for a saved group card (groups list, group detail). */
export function savedGroupDropId(groupId: string) {
  return `${SAVED_GROUP_PREFIX}${groupId}`;
}

export function isSavedGroupDropId(dropId: string) {
  return dropId.startsWith(SAVED_GROUP_PREFIX);
}

export function parseSavedGroupDropId(dropId: string) {
  return dropId.slice(SAVED_GROUP_PREFIX.length);
}
