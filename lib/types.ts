export interface Workspace {
  id: string;
  name: string;
  color: string;
  position: number;
  seq: number;        // 0 = never synced to server
  deletedAt?: number; // unix ms; undefined = alive
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
  favicon: string;
  collectionId: string;
  tags: string[]; // tag IDs
  createdAt: string;
  isFavorite: boolean;
  hasDarkIcon?: boolean;
  seq: number;
  deletedAt?: number;
}
