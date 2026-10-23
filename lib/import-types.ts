import type { Bookmark, Collection, Tag } from "@/lib/types";

export interface ValidationResult {
  valid: boolean;
  error?: string;
  preview?: { collections: number; bookmarks: number };
}

export interface ImportTagOptions {
  enabled: boolean;
  rootName: string;
  existingTags: readonly Tag[];
  availableTags: number; // -1 means unlimited
}

export interface ImportPlan {
  collections: Omit<Collection, "seq">[];
  bookmarks: Omit<Bookmark, "seq">[];
  tags: Omit<Tag, "seq">[];
  duplicatesSkipped: number;
  rejectedUrls: string[];
  provenance?: {
    rootTagId?: string;
    mode: "full" | "root-only" | "none";
    requestedTagCount: number;
  };
}

export type ImportCommitResult =
  | {
      ok: true;
      collectionsCreated: number;
      bookmarksImported: number;
      tagsCreated: number;
      rootTagId?: string;
    }
  | {
      ok: false;
      error: "quota" | "target_unavailable" | "stale_plan" | "storage";
    };
