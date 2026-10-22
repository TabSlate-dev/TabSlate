import { normalizeCoverUrl } from "@/lib/bookmark-utils";
import { readPageInfo } from "@/lib/page-info";

export const FETCH_DETAILS_TIMEOUT_MS = 10_000;
export const FETCH_DETAILS_MAX_BYTES = 2 * 1024 * 1024;

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);

export interface PageMetadata {
  title: string;
  description: string;
  /** The normalized cover URL; "" when the page declares none. */
  imageUrl: string;
}

export type FetchPageMetadataError = "timeout" | "network" | "http" | "not-html" | "no-metadata";

export type FetchPageMetadataResult =
  | { status: "ok"; metadata: PageMetadata }
  | { status: "error"; reason: FetchPageMetadataError };

/** The match pattern for a page's site, e.g. "https://example.com/*"; match patterns carry no port. */
export function siteAccessPattern(url: string): string {
  const { protocol, hostname } = new URL(url);
  return `${protocol}//${hostname}/*`;
}

/**
 * Asks for access to the page's site, which resolves true at once when the
 * all-sites permission is granted. Call it in the click handler before any
 * await: browsers grant permission requests only during the user's gesture.
 */
export function requestSiteAccess(url: string): Promise<boolean> {
  return chrome.permissions.request({ origins: [siteAccessPattern(url)] });
}

/** At most maxBytes of the body. Pages declare their metadata in <head>, so a cut-off body still parses. */
async function readLimitedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    return new Uint8Array();
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (received < maxBytes) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = value.subarray(0, maxBytes - received);
    chunks.push(chunk);
    received += chunk.length;
  }
  if (received >= maxBytes) {
    await reader.cancel();
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function charsetIn(text: string): string | undefined {
  return /charset\s*=\s*["']?([\w-]+)/i.exec(text)?.[1];
}

/** Only meta declarations choose the fallback encoding; script text can also contain "charset=". */
function metaCharset(bytes: Uint8Array): string | undefined {
  const prefix = String.fromCharCode(...bytes.subarray(0, 1024));
  const doc = new DOMParser().parseFromString(prefix, "text/html");
  const charset = doc.querySelector("meta[charset]")?.getAttribute("charset")?.trim();
  return charset || charsetIn(doc.querySelector('meta[http-equiv="content-type" i]')?.getAttribute("content") ?? "");
}

/** Decodes with the header's charset, else one a <meta> declares near the start, else UTF-8. */
function decodeHtml(bytes: Uint8Array, contentType: string): string {
  const label = charsetIn(contentType) ?? metaCharset(bytes) ?? "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/**
 * Fetches a page from the browser, without cookies, and reads its title,
 * description and cover. DOMParser never runs the page's scripts.
 */
export async function fetchPageMetadata(
  url: string,
  timeoutMs: number = FETCH_DETAILS_TIMEOUT_MS,
): Promise<FetchPageMetadataResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { credentials: "omit", redirect: "follow", signal: controller.signal });
    if (!response.ok) {
      return { status: "error", reason: "http" };
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!HTML_TYPES.has(contentType.split(";")[0]?.trim().toLowerCase() ?? "")) {
      return { status: "error", reason: "not-html" };
    }
    const html = decodeHtml(await readLimitedBytes(response, FETCH_DETAILS_MAX_BYTES), contentType);
    const pageUrl = response.url || url;
    const info = readPageInfo(new DOMParser().parseFromString(html, "text/html"), pageUrl);
    const metadata: PageMetadata = {
      title: info.ogTitle || info.title.trim(),
      description: info.metaDescription,
      imageUrl: normalizeCoverUrl(info.ogImage, pageUrl) ?? "",
    };
    if (!metadata.title && !metadata.description && !metadata.imageUrl) {
      return { status: "error", reason: "no-metadata" };
    }
    return { status: "ok", metadata };
  } catch {
    return { status: "error", reason: controller.signal.aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}
