import { generateId } from "@/lib/id";
import type { ImportPlan, ValidationResult } from "@/lib/import-types";
import type { Bookmark, Collection } from "@/lib/types";

const SAFE_SCHEMES = new Set(["http:", "https:", "ftp:", "ftps:"]);
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 500;
const NETSCAPE_DOCTYPE = "NETSCAPE-Bookmark-file-1";
const SKIP_ROOT_FOLDERS = new Set(["mobile bookmarks"]);

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

export interface ParsedCollection {
  name: string;
  items: { title: string; url: string }[];
}

export function parseChromeHTML(html: string): ParsedCollection[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const result: ParsedCollection[] = [];
  const usedNames = new Set<string>();

  function allocateName(preferred: string): string {
    if (!usedNames.has(preferred)) {
      usedNames.add(preferred);
      return preferred;
    }

    let suffix = 2;
    while (usedNames.has(`${preferred} (${suffix})`)) {
      suffix++;
    }

    const name = `${preferred} (${suffix})`;
    usedNames.add(name);
    return name;
  }

  function collectBookmarks(dlEl: Element, target: ParsedCollection): void {
    for (const child of Array.from(dlEl.children)) {
      if (child.tagName !== "DT") {
        continue;
      }

      const anchor = child.querySelector(":scope > a");
      if (anchor) {
        target.items.push({
          title: anchor.textContent?.trim() ?? "",
          url: anchor.getAttribute("href") ?? "",
        });
        continue;
      }

      const nestedDL = child.querySelector(":scope > dl");
      if (nestedDL) {
        collectBookmarks(nestedDL, target);
      }
    }
  }

  const rootDL = doc.querySelector("dl");
  if (!rootDL) {
    return result;
  }

  for (const rootChild of Array.from(rootDL.children)) {
    if (rootChild.tagName !== "DT") {
      continue;
    }

    const rootHeading = rootChild.querySelector(":scope > h3");
    if (!rootHeading) {
      continue;
    }

    const rootFolderName = rootHeading.textContent?.trim() ?? "";
    if (SKIP_ROOT_FOLDERS.has(rootFolderName.toLowerCase())) {
      continue;
    }

    const rootFolderList = rootChild.querySelector(":scope > dl");
    if (!rootFolderList) {
      continue;
    }

    let rootCollection: ParsedCollection | null = null;

    for (const folderChild of Array.from(rootFolderList.children)) {
      if (folderChild.tagName !== "DT") {
        continue;
      }

      const anchor = folderChild.querySelector(":scope > a");
      const heading = folderChild.querySelector(":scope > h3");

      if (anchor) {
        if (rootCollection === null) {
          rootCollection = {
            name: allocateName(rootFolderName),
            items: [],
          };
          result.push(rootCollection);
        }

        rootCollection.items.push({
          title: anchor.textContent?.trim() ?? "",
          url: anchor.getAttribute("href") ?? "",
        });
        continue;
      }

      if (!heading) {
        continue;
      }

      const subCollection: ParsedCollection = {
        name: allocateName(heading.textContent?.trim() ?? ""),
        items: [],
      };
      result.push(subCollection);

      const subFolderList = folderChild.querySelector(":scope > dl");
      if (subFolderList) {
        collectBookmarks(subFolderList, subCollection);
      }
    }
  }

  return result;
}

export async function validateChromeFile(file: File): Promise<ValidationResult> {
  if (file.size > MAX_FILE_SIZE) {
    return {
      valid: false,
      error: "File too large. Chrome bookmark exports are typically under 10 MB.",
    };
  }

  const lowerName = file.name.toLowerCase();
  if (!lowerName.endsWith(".html") && !lowerName.endsWith(".htm")) {
    return {
      valid: false,
      error: "Please upload an HTML file. Export from Chrome: Bookmarks Manager → ⋮ → Export bookmarks.",
    };
  }

  const text = await file.text();
  if (!text.slice(0, 256).includes(NETSCAPE_DOCTYPE)) {
    return {
      valid: false,
      error: "This doesn't look like a Chrome bookmarks export file.",
    };
  }

  const collections = parseChromeHTML(text).filter((collection) => collection.items.length > 0);
  const bookmarkCount = collections.reduce((count, collection) => count + collection.items.length, 0);

  if (bookmarkCount === 0) {
    return {
      valid: false,
      error: "This export file contains no bookmarks to import.",
    };
  }

  return {
    valid: true,
    preview: {
      collections: collections.length,
      bookmarks: bookmarkCount,
    },
  };
}

export function buildChromeImportPlan(
  parsed: ParsedCollection[],
  workspaceId: string,
  existingBookmarkUrls: Set<string>,
  skipDuplicates: boolean,
  startPosition = 0,
): ImportPlan {
  const collections: Omit<Collection, "seq">[] = [];
  const bookmarks: Omit<Bookmark, "seq">[] = [];
  const rejectedUrls: string[] = [];
  const createdAt = new Date().toISOString();
  const seenUrls = new Set(existingBookmarkUrls);
  let duplicatesSkipped = 0;
  let position = startPosition;

  for (const parsedCollection of parsed) {
    if (parsedCollection.items.length === 0) {
      continue;
    }

    const collectionId = generateId();
    collections.push({
      id: collectionId,
      workspaceId,
      name: parsedCollection.name.slice(0, MAX_TITLE_LENGTH),
      icon: "",
      position,
    });
    position++;

    for (const item of parsedCollection.items) {
      const url = item.url.trim();
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

      seenUrls.add(url);
      bookmarks.push({
        id: generateId(),
        title: (item.title || url).slice(0, MAX_TITLE_LENGTH),
        url,
        description: "",
        favicon: "",
        collectionId,
        tags: [],
        createdAt,
        isFavorite: false,
      });
    }
  }

  return {
    collections,
    bookmarks,
    tags: [],
    duplicatesSkipped,
    rejectedUrls,
  };
}
