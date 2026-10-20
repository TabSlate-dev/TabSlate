import type { Bookmark } from "@/lib/types";

/**
 * "strict" blocks a save, so it only ignores differences that never change the
 * page: scheme and host case, a default port, a trailing slash. Path, query and
 * fragment keep their case (short links and video IDs are case-sensitive).
 * "loose" only produces a warning, so it also ignores http/https, a leading
 * www., the fragment and tracking parameters.
 */
export type UrlMatchTier = "strict" | "loose";

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "yclid",
  "_hsenc",
  "_hsmi",
]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_PARAMS.has(lower);
}

function parseWebUrl(url: string): URL | null {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function serializeAuthority(parsed: URL, host: string): string {
  const userInfo = parsed.username !== "" || parsed.password !== ""
    ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ""}@`
    : "";
  return `${userInfo}${host}`;
}

function trimTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

export function strictUrlKey(url: string): string {
  const parsed = parseWebUrl(url);
  if (!parsed) {
    return url.trim();
  }
  // URL already lowercases the scheme and host and drops default ports.
  return `${parsed.protocol}//${serializeAuthority(parsed, parsed.host)}${trimTrailingSlash(parsed.pathname)}${parsed.search}${parsed.hash}`;
}

export function looseUrlKey(url: string): string {
  const parsed = parseWebUrl(url);
  if (!parsed) {
    return url.trim();
  }
  const hostname = parsed.hostname.startsWith("www.") ? parsed.hostname.slice(4) : parsed.hostname;
  const host = `${hostname}${parsed.port ? `:${parsed.port}` : ""}`;
  const authority = serializeAuthority(parsed, host);
  const params = new URLSearchParams(parsed.search);
  for (const name of Array.from(params.keys())) {
    if (isTrackingParam(name)) {
      params.delete(name);
    }
  }
  const query = params.toString();
  return `${authority}${trimTrailingSlash(parsed.pathname)}${query ? `?${query}` : ""}`;
}

/**
 * The site part of a sort by website: the host, lowercased, without a leading
 * "www.". Subdomains stay separate sites. Null for an address that is not a web URL.
 */
export function siteSortKey(url: string): string | null {
  const parsed = parseWebUrl(url);
  return parsed ? parsed.hostname.replace(/^www\./, "") : null;
}

export function urlMatchKey(url: string, tier: UrlMatchTier): string {
  return tier === "strict" ? strictUrlKey(url) : looseUrlKey(url);
}

export function findUrlMatches(url: string, bookmarks: readonly Bookmark[], tier: UrlMatchTier): Bookmark[] {
  const key = urlMatchKey(url, tier);
  return bookmarks.filter((bookmark) => !!bookmark.url && urlMatchKey(bookmark.url, tier) === key);
}
