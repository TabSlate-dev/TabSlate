/** A page's metadata, as GET_PAGE_INFO answers with it. */
export interface PageInfo {
  title: string;
  url: string;
  selectedText: string;
  favicon: string;
  ogTitle: string;
  metaDescription: string;
  /** The og:image (else twitter:image) URL resolved against the page; "" when the page declares none. */
  ogImage: string;
}

interface RequestPageInfoOptions {
  /** Run the reader in the tab when its content script does not answer; needs activeTab or host access. */
  allowInjection: boolean;
}

/**
 * Reads a page's metadata. It references nothing outside its own body, so
 * chrome.scripting.executeScript can run it from its source text, and its
 * parameters default to the page it runs in. fetchPageMetadata passes a
 * parsed document and the URL it came from.
 */
export function readPageInfo(doc: Document = document, pageUrl: string = location.href): PageInfo {
  let baseUrl = pageUrl;
  try {
    baseUrl = new URL(doc.querySelector("base[href]")?.getAttribute("href") ?? "", pageUrl).href;
  } catch {
    // Without a usable base, relative URLs resolve against the page.
  }
  const resolve = (raw: string): string => {
    try {
      return new URL(raw, baseUrl).href;
    } catch {
      return "";
    }
  };
  const firstContent = (selectors: string[]): string => {
    for (const selector of selectors) {
      const value = doc.querySelector(selector)?.getAttribute("content")?.trim();
      if (value) {
        return value;
      }
    }
    return "";
  };
  let origin = "";
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    // A page URL that does not parse gets no favicon fallback.
  }
  const iconHref = (doc.querySelector('link[rel="icon"]') ?? doc.querySelector('link[rel="shortcut icon"]'))
    ?.getAttribute("href")?.trim();
  const ogImage = firstContent(['meta[property="og:image"]', 'meta[name="twitter:image"]', 'meta[property="twitter:image"]']);
  return {
    title: doc.title,
    url: pageUrl,
    selectedText: doc.getSelection()?.toString().trim() ?? "",
    favicon: iconHref ? resolve(iconHref) : origin && origin !== "null" ? `${origin}/favicon.ico` : "",
    ogTitle: firstContent(['meta[property="og:title"]']),
    metaDescription: firstContent(['meta[property="og:description"]', 'meta[name="description"]']),
    ogImage: ogImage ? resolve(ogImage) : "",
  };
}

function readText(record: object, key: string): string {
  const value: unknown = Reflect.get(record, key);
  return typeof value === "string" ? value : "";
}

/** A page-info answer with every field present, or null when there is no answer. */
function toPageInfo(value: unknown): PageInfo | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return {
    title: readText(value, "title"),
    url: readText(value, "url"),
    selectedText: readText(value, "selectedText"),
    favicon: readText(value, "favicon"),
    ogTitle: readText(value, "ogTitle"),
    metaDescription: readText(value, "metaDescription"),
    ogImage: readText(value, "ogImage"),
  };
}

/**
 * The tab's page info: from its content script, else, with allowInjection,
 * by running readPageInfo in the tab. Null when neither works, such as on
 * browser pages or in a tab the extension has no access to.
 */
export async function requestPageInfo(tabId: number, options: RequestPageInfoOptions): Promise<PageInfo | null> {
  try {
    const info = toPageInfo(await chrome.tabs.sendMessage<{ type: "GET_PAGE_INFO" }, unknown>(tabId, { type: "GET_PAGE_INFO" }));
    if (info) {
      return info;
    }
  } catch {
    // No content script in the tab: the all-sites permission is off, or the page does not allow one.
  }
  if (!options.allowInjection) {
    return null;
  }
  try {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: readPageInfo });
    return toPageInfo(injection?.result);
  } catch {
    return null;
  }
}
