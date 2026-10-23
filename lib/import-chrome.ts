import { generateId } from "@/lib/id";
import { addImportTags } from "@/lib/import-tags";
import type { ImportPlan, ImportTagOptions, ValidationResult } from "@/lib/import-types";
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
  items: { title: string; url: string; folderPath: string[] }[];
}

function getDTElements(parent: Element): Element[] {
  const dts: Element[] = [];
  function collect(node: Element) {
    for (const child of Array.from(node.children)) {
      if (child.tagName === "DT") {
        dts.push(child);
        for (const dtChild of Array.from(child.children)) {
          if (dtChild.tagName === "P") {
            collect(dtChild);
          }
        }
      } else if (child.tagName === "P") {
        collect(child);
      }
    }
  }
  collect(parent);
  return dts;
}

function getDirectAnchor(dt: Element): HTMLAnchorElement | null {
  return dt.querySelector(":scope > a, :scope > p > a");
}

function getDirectHeading(dt: Element): HTMLHeadingElement | null {
  return dt.querySelector(":scope > h3, :scope > p > h3");
}

function getDirectDL(dt: Element): Element | null {
  return dt.querySelector(":scope > dl, :scope > p > dl");
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

  function collectBookmarks(dlEl: Element, target: ParsedCollection, currentFolderPath: string[] = []): void {
    for (const child of getDTElements(dlEl)) {
      const anchor = getDirectAnchor(child);
      if (anchor) {
        target.items.push({
          title: anchor.textContent?.trim() ?? "",
          url: anchor.getAttribute("href") ?? "",
          folderPath: [...currentFolderPath],
        });
        continue;
      }

      const heading = getDirectHeading(child);
      const nestedDL = getDirectDL(child);
      if (nestedDL) {
        const folderName = heading?.textContent?.trim() ?? "";
        const nextFolderPath = folderName ? [...currentFolderPath, folderName] : currentFolderPath;
        collectBookmarks(nestedDL, target, nextFolderPath);
      }
    }
  }

  const rootDL = doc.querySelector("dl");
  if (!rootDL) {
    return result;
  }

  for (const rootChild of getDTElements(rootDL)) {
    const rootHeading = getDirectHeading(rootChild);
    if (!rootHeading) {
      continue;
    }

    const rootFolderName = rootHeading.textContent?.trim() ?? "";
    if (SKIP_ROOT_FOLDERS.has(rootFolderName.toLowerCase())) {
      continue;
    }

    const rootFolderList = getDirectDL(rootChild);
    if (!rootFolderList) {
      continue;
    }

    let rootCollection: ParsedCollection | null = null;

    for (const folderChild of getDTElements(rootFolderList)) {
      const anchor = getDirectAnchor(folderChild);
      const heading = getDirectHeading(folderChild);

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
          folderPath: [],
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

      const subFolderList = getDirectDL(folderChild);
      if (subFolderList) {
        collectBookmarks(subFolderList, subCollection, []);
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
  tagOptions?: ImportTagOptions,
): ImportPlan {
  const collections: Omit<Collection, "seq">[] = [];
  const bookmarks: Omit<Bookmark, "seq">[] = [];
  const rejectedUrls: string[] = [];
  const createdAt = new Date().toISOString();
  const seenUrls = new Set(existingBookmarkUrls);
  const pathsByBookmarkId = new Map<string, readonly string[]>();
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
      const bookmarkId = generateId();
      pathsByBookmarkId.set(bookmarkId, item.folderPath);
      bookmarks.push({
        id: bookmarkId,
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

  const basePlan: ImportPlan = {
    collections,
    bookmarks,
    tags: [],
    duplicatesSkipped,
    rejectedUrls,
  };

  if (!tagOptions) {
    return basePlan;
  }

  return addImportTags(basePlan, "chrome", pathsByBookmarkId, tagOptions);
}
