export interface Workspace {
  id: string;
  name: string;
  color: string;
  position: number;
  seq: number;        // 0 = never synced to server
  deletedAt?: number; // unix ms; undefined = alive
  deletionModel?: 0 | 1;
}

export interface Collection {
  id: string;
  workspaceId: string;
  name: string;
  icon: string;
  position: number;
  isDefault?: boolean; // auto-created per workspace, cannot be deleted
  seq: number;
  deletedAt?: number;
  archivedAt?: number;  // unix ms; undefined = active, set = archived
}

export interface Tag {
  id: string;
  name: string;
  color: string; // tailwind classes e.g. "bg-blue-500/10 text-blue-500"
  seq: number;
  deletedAt?: number;
}

export interface Bookmark {
  id: string;
  title: string;
  url: string;
  description: string;
  /** Plain-text notes; a missing value means "". */
  notes?: string;
  favicon: string;
  /** The page's cover (og:image) URL; a missing value or "" means no cover. */
  imageUrl?: string;
  collectionId: string;
  tags: string[]; // tag IDs
  createdAt: string;
  /** Unix ms of the user's last change; missing for bookmarks saved before edit times existed. */
  updatedAt?: number;
  isFavorite: boolean;
  hasDarkIcon?: boolean;
  seq: number;
  deletedAt?: number;
}

/** The fields a batch update may change. */
export type BookmarkBatchPatch = Partial<
  Pick<Bookmark, "title" | "url" | "description" | "notes" | "imageUrl" | "collectionId" | "tags" | "isFavorite">
>;

export interface BookmarkPatchEntry {
  id: string;
  patch: BookmarkBatchPatch;
}
