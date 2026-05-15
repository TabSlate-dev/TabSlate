import { generateId } from "@/lib/id";
import type { ImportPlan, ValidationResult } from "@/lib/import-types";
import type { Bookmark, Collection, Tag } from "@/lib/types";

const SAFE_SCHEMES = new Set(["http:", "https:", "ftp:", "ftps:"]);
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 2000;
const DEFAULT_TAG_COLOR = "bg-blue-500/10 text-blue-500";

interface TobyCard {
  title?: string;
  url?: string;
  customTitle?: string;
  customDescription?: string;
}

interface TobyList {
  title?: string;
  cards?: TobyCard[];
  labels?: string[];
}

export interface TobyImport {
  version: number;
  lists: TobyList[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return value.trim();
}

function parseTobyCard(raw: unknown): TobyCard {
  if (!isRecord(raw)) {
    return {};
  }

  return {
    title: asTrimmedString(raw.title),
    url: asTrimmedString(raw.url),
    customTitle: asTrimmedString(raw.customTitle),
    customDescription: asTrimmedString(raw.customDescription),
  };
}

function parseTobyList(raw: unknown): TobyList {
  if (!isRecord(raw)) {
    return {};
  }

  const cards = Array.isArray(raw.cards) ? raw.cards.map(parseTobyCard) : undefined;
  const labels = Array.isArray(raw.labels)
    ? raw.labels
      .filter((label): label is string => typeof label === "string")
      .map((label) => label.trim())
      .filter((label) => label.length > 0)
    : undefined;

  return {
    title: asTrimmedString(raw.title),
    cards,
    labels,
  };
}

function isSafeUrl(url: string): boolean {
  if (url.length > MAX_URL_LENGTH) {
    return false;
  }

  try {
    return SAFE_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

function truncate(value: string, maxLength: number): string {
  return value.slice(0, maxLength);
}

export function parseTobyJSON(raw: unknown): TobyImport | null {
  if (!isRecord(raw)) {
    return null;
  }

  if (typeof raw.version !== "number") {
    return null;
  }

  if (!Array.isArray(raw.lists)) {
    return null;
  }

  const lists: TobyList[] = [];
  for (const rawList of raw.lists) {
    lists.push(parseTobyList(rawList));
  }

  return {
    version: raw.version,
    lists,
  };
}

export async function validateTobyFile(file: File): Promise<ValidationResult> {
  if (file.size > MAX_FILE_SIZE) {
    return { valid: false, error: "File too large. Toby exports are typically under 5 MB." };
  }

  if (!file.name.toLowerCase().endsWith(".json")) {
    return { valid: false, error: "Unrecognized format. Please export from Toby as JSON (not HTML)." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return { valid: false, error: "This doesn't look like a Toby export file." };
  }

  if (!isRecord(parsed) || !("version" in parsed) || !("lists" in parsed)) {
    return { valid: false, error: "Unrecognized format. Please export from Toby as JSON (not HTML)." };
  }

  if (parsed.version !== 3) {
    return { valid: false, error: "Unsupported Toby format version. Only v3 is supported." };
  }

  const toby = parseTobyJSON(parsed);
  if (!toby) {
    return { valid: false, error: "Unrecognized format. Please export from Toby as JSON (not HTML)." };
  }

  const nonEmptyLists = toby.lists.filter((list) => (list.cards?.length ?? 0) > 0);
  if (nonEmptyLists.length === 0) {
    return { valid: false, error: "This export file contains no collections to import." };
  }

  const bookmarkCount = nonEmptyLists.reduce((count, list) => count + (list.cards?.length ?? 0), 0);

  return {
    valid: true,
    preview: {
      collections: nonEmptyLists.length,
      bookmarks: bookmarkCount,
    },
  };
}

export function buildTobyImportPlan(
  toby: TobyImport | null,
  workspaceId: string,
  existingBookmarkUrls: Set<string>,
  existingTags: Pick<Tag, "id" | "name">[],
  skipDuplicates: boolean,
): ImportPlan {
  if (!toby) {
    return {
      collections: [],
      bookmarks: [],
      tags: [],
      duplicatesSkipped: 0,
      rejectedUrls: [],
    };
  }

  const tagIdByName = new Map<string, string>();
  for (const existingTag of existingTags) {
    const normalizedName = existingTag.name.trim().toLowerCase();
    if (normalizedName.length === 0) {
      continue;
    }

    tagIdByName.set(normalizedName, existingTag.id);
  }

  const collections: Omit<Collection, "seq">[] = [];
  const bookmarks: Omit<Bookmark, "seq">[] = [];
  const tags: Omit<Tag, "seq">[] = [];
  const rejectedUrls: string[] = [];
  const seenUrls = new Set(existingBookmarkUrls);
  const createdAt = new Date().toISOString();
  let duplicatesSkipped = 0;
  let position = 0;

  for (const list of toby.lists) {
    const cards = list.cards ?? [];
    if (cards.length === 0) {
      continue;
    }

    const tagIds: string[] = [];
    const seenLabels = new Set<string>();
    for (const label of list.labels ?? []) {
      const normalizedLabel = label.toLowerCase();
      if (normalizedLabel.length === 0 || seenLabels.has(normalizedLabel)) {
        continue;
      }

      seenLabels.add(normalizedLabel);

      const existingTagId = tagIdByName.get(normalizedLabel);
      if (existingTagId) {
        tagIds.push(existingTagId);
        continue;
      }

      const tagId = generateId();
      tagIdByName.set(normalizedLabel, tagId);
      tags.push({
        id: tagId,
        name: truncate(label, MAX_TITLE_LENGTH),
        color: DEFAULT_TAG_COLOR,
      });
      tagIds.push(tagId);
    }

    const collectionId = generateId();
    collections.push({
      id: collectionId,
      workspaceId,
      name: truncate(list.title ?? "Untitled", MAX_TITLE_LENGTH),
      icon: "",
      position,
    });
    position++;

    for (const card of cards) {
      const url = card.url?.trim() ?? "";
      if (!isSafeUrl(url)) {
        if (url.length > 0) {
          rejectedUrls.push(url);
        }
        continue;
      }

      if (skipDuplicates && seenUrls.has(url)) {
        duplicatesSkipped++;
        continue;
      }

      if (skipDuplicates) {
        seenUrls.add(url);
      }

      const title = card.customTitle || card.title || url;
      bookmarks.push({
        id: generateId(),
        title: truncate(title, MAX_TITLE_LENGTH),
        url,
        description: truncate(card.customDescription ?? "", MAX_DESCRIPTION_LENGTH),
        favicon: "",
        collectionId,
        tags: [...tagIds],
        createdAt,
        isFavorite: false,
      });
    }
  }

  return {
    collections,
    bookmarks,
    tags,
    duplicatesSkipped,
    rejectedUrls,
  };
}
