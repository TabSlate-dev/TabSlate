import type { Bookmark, Collection, Tag } from "@/lib/types";

export interface ValidationResult {
  valid: boolean;
  error?: string;
  preview?: { collections: number; bookmarks: number };
}

export interface ImportPlan {
  collections: Omit<Collection, "seq">[];
  bookmarks: Omit<Bookmark, "seq">[];
  tags: Omit<Tag, "seq">[];
  duplicatesSkipped: number;
  rejectedUrls: string[];
}
