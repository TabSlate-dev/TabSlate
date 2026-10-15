import { idbGet, idbPut } from "@/lib/idb";
import { getPreferences, updatePreferences } from "@/lib/api";

export type BookmarkViewMode = "grid" | "list";
export type BookmarkSortBy = "date-newest" | "date-oldest" | "alpha-az" | "alpha-za";

const VIEW_MODES: readonly BookmarkViewMode[] = ["grid", "list"];
const SORT_OPTIONS: readonly BookmarkSortBy[] = ["date-newest", "date-oldest", "alpha-az", "alpha-za"];

export const DEFAULT_VIEW_MODE: BookmarkViewMode = "grid";
export const DEFAULT_SORT_BY: BookmarkSortBy = "date-newest";
export const VIEW_PREFS_KV_KEY = "bookmark-view-prefs";
export const VIEW_PREFS_SERVER_KEY = "bookmarkView";

export interface BookmarkViewPrefs {
  viewMode: BookmarkViewMode;
  sortBy: BookmarkSortBy;
  /** Unix ms of the user's last change; the newer side wins. */
  updatedAt: number;
}

export interface StoredViewPrefs extends BookmarkViewPrefs {
  /** The local value has not reached the server yet. */
  dirty: boolean;
}

export interface PreferenceCredentials {
  baseUrl: string;
  accessToken: string;
}

export type PushViewPrefsResult =
  | { status: "pushed" }
  | { status: "ineligible" }
  | { status: "remote-newer"; prefs: BookmarkViewPrefs };

export type PullAction = "apply-remote" | "push-local" | "none";

interface KvRecord {
  key: string;
  value: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isViewMode(value: unknown): value is BookmarkViewMode {
  return VIEW_MODES.some((mode) => mode === value);
}

function isSortBy(value: unknown): value is BookmarkSortBy {
  return SORT_OPTIONS.some((option) => option === value);
}

/** Reads a stored or synced value, defaulting fields from other client versions. */
export function parseViewPrefs(value: unknown): BookmarkViewPrefs | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    viewMode: isViewMode(value.viewMode) ? value.viewMode : DEFAULT_VIEW_MODE,
    sortBy: isSortBy(value.sortBy) ? value.sortBy : DEFAULT_SORT_BY,
    updatedAt: typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
}

/** Last write wins, with dirty local values winning timestamp ties. */
export function resolvePullAction(local: StoredViewPrefs | null, remote: BookmarkViewPrefs | null): PullAction {
  if (remote === null) {
    return local ? "push-local" : "none";
  }
  if (local === null || remote.updatedAt > local.updatedAt) {
    return "apply-remote";
  }
  if (local.dirty || local.updatedAt > remote.updatedAt) {
    return "push-local";
  }
  return "none";
}

export async function readLocalViewPrefs(): Promise<StoredViewPrefs | null> {
  const record = await idbGet<KvRecord>("kv", VIEW_PREFS_KV_KEY);
  const raw = record?.value;
  const prefs = parseViewPrefs(raw);
  if (prefs === null) {
    return null;
  }
  return { ...prefs, dirty: isRecord(raw) && raw.dirty === true };
}

export async function writeLocalViewPrefs(prefs: StoredViewPrefs): Promise<void> {
  await idbPut<KvRecord>("kv", { key: VIEW_PREFS_KV_KEY, value: prefs });
}

export async function fetchRemoteViewPrefs(credentials: PreferenceCredentials): Promise<BookmarkViewPrefs | null> {
  const preferences = await getPreferences(credentials.baseUrl, credentials.accessToken);
  return parseViewPrefs(preferences[VIEW_PREFS_SERVER_KEY]);
}

/** Read-merge-write so other preference keys on the server survive. */
export async function pushViewPrefs(
  credentials: PreferenceCredentials,
  prefs: BookmarkViewPrefs,
  isEligible: () => boolean | Promise<boolean> = () => true,
): Promise<PushViewPrefsResult> {
  const preferences = await getPreferences(credentials.baseUrl, credentials.accessToken);
  if (!(await isEligible())) {
    return { status: "ineligible" };
  }
  const remote = parseViewPrefs(preferences[VIEW_PREFS_SERVER_KEY]);
  if (remote && remote.updatedAt > prefs.updatedAt) {
    return { status: "remote-newer", prefs: remote };
  }
  await updatePreferences(credentials.baseUrl, credentials.accessToken, {
    ...preferences,
    [VIEW_PREFS_SERVER_KEY]: { viewMode: prefs.viewMode, sortBy: prefs.sortBy, updatedAt: prefs.updatedAt },
  });
  return { status: "pushed" };
}
