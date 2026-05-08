import { create } from "zustand";
import { idbGet, idbPut } from "@/lib/idb";
import { getPreferences, updatePreferences } from "@/lib/api";
import { useAuthStore } from "@/store/auth-store";

export interface SearchEngine {
  id: string;
  name: string;
  url: string;       // %s placeholder, e.g. "https://example.com/search?q=%s"
  siteUrl: string;
  iconUrl?: string;
  custom?: boolean;  // true for user-created engines
  enabled: boolean;
}

export const DEFAULT_SEARCH_ENGINES: SearchEngine[] = [
  { id: "google", name: "Google", url: "https://www.google.com/search?q=%s", siteUrl: "https://www.google.com", iconUrl: "search-engine-icon/brand-google.svg", enabled: true },
  { id: "bing", name: "Bing", url: "https://www.bing.com/search?q=%s", siteUrl: "https://www.bing.com", iconUrl: "search-engine-icon/brand-bing.svg", enabled: true },
  { id: "duckduckgo", name: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s", siteUrl: "https://duckduckgo.com", iconUrl: "search-engine-icon/brand-duckduckgo.svg", enabled: true },
  { id: "yahoo", name: "Yahoo", url: "https://search.yahoo.com/search?p=%s", siteUrl: "https://www.yahoo.com", iconUrl: "search-engine-icon/brand-yahoo.svg", enabled: true },
  { id: "yandex", name: "Yandex", url: "https://yandex.com/search/?text=%s", siteUrl: "https://yandex.com", iconUrl: "search-engine-icon/brand-yandex.svg", enabled: true },
  { id: "github", name: "GitHub", url: "https://github.com/search?q=%s", siteUrl: "https://github.com", iconUrl: "search-engine-icon/brand-github.svg", enabled: true },
];

function mergeEngines(saved: SearchEngine[]): SearchEngine[] {
  const merged = saved.map(s => {
    const def = DEFAULT_SEARCH_ENGINES.find(d => d.id === s.id);
    return def ? { ...def, enabled: s.enabled !== false } : s;
  });
  // Append any new engines added to DEFAULT_SEARCH_ENGINES later
  const newEngines = DEFAULT_SEARCH_ENGINES.filter(d => !saved.find(s => s.id === d.id));
  return [...merged, ...newEngines];
}

interface SettingsState {
  searchEngines: SearchEngine[];
  _hydrated: boolean;
  hydrate: () => Promise<void>;
  /** Update search engines locally (IDB) and push to server. */
  updateSearchEngines: (engines: SearchEngine[]) => void;
  /** Pull preferences from server and merge into local state. Called after login. */
  pullFromServer: (serverUrl: string, accessToken: string) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  searchEngines: DEFAULT_SEARCH_ENGINES,
  _hydrated: false,

  hydrate: async () => {
    const enginesKv = await idbGet<{ key: string; value: SearchEngine[] }>("kv", "searchEngines");
    if (enginesKv?.value && Array.isArray(enginesKv.value) && enginesKv.value.length > 0) {
      set({ searchEngines: mergeEngines(enginesKv.value), _hydrated: true });
    } else {
      set({ _hydrated: true });
    }
  },

  updateSearchEngines: (engines) => {
    set({ searchEngines: engines });
    idbPut("kv", { key: "searchEngines", value: engines });

    // Fire-and-forget push to server
    const { serverUrl, accessToken } = useAuthStore.getState();
    if (serverUrl && accessToken) {
      updatePreferences(serverUrl, accessToken, {
        search_engines: engines,
      }).catch(() => { /* silent — local IDB is source of truth fallback */ });
    }
  },

  pullFromServer: async (serverUrl, accessToken) => {
    try {
      const prefs = await getPreferences(serverUrl, accessToken);
      if (prefs && Array.isArray(prefs.search_engines) && prefs.search_engines.length > 0) {
        const serverEngines = mergeEngines(prefs.search_engines as SearchEngine[]);
        set({ searchEngines: serverEngines });
        idbPut("kv", { key: "searchEngines", value: serverEngines });
      }
    } catch {
      // Server unreachable or no preferences saved yet — keep local state
    }
  },
}));
