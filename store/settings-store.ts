import { create } from "zustand";
import { idbGet, idbPut } from "@/lib/idb";
import { getPreferences, updatePreferences } from "@/lib/api";
import { useAuthStore } from "@/store/auth-store";

export interface SearchEngine {
  id: string;
  name: string;
  url: string;
  siteUrl: string;
  enabled: boolean;
}

export const DEFAULT_SEARCH_ENGINES: SearchEngine[] = [
  { id: "google", name: "Google", url: "https://www.google.com/search?q=", siteUrl: "https://www.google.com", enabled: true },
  { id: "bing", name: "Bing", url: "https://www.bing.com/search?q=", siteUrl: "https://www.bing.com", enabled: true },
  { id: "duckduckgo", name: "DuckDuckGo", url: "https://duckduckgo.com/?q=", siteUrl: "https://duckduckgo.com", enabled: true },
  { id: "baidu", name: "Baidu", url: "https://www.baidu.com/s?wd=", siteUrl: "https://www.baidu.com", enabled: true },
  { id: "yahoo", name: "Yahoo", url: "https://search.yahoo.com/search?p=", siteUrl: "https://www.yahoo.com", enabled: true },
  { id: "yandex", name: "Yandex", url: "https://yandex.com/search/?text=", siteUrl: "https://yandex.com", enabled: true },
  { id: "ecosia", name: "Ecosia", url: "https://www.ecosia.org/search?q=", siteUrl: "https://www.ecosia.org", enabled: true },
  { id: "kagi", name: "Kagi", url: "https://kagi.com/search?q=", siteUrl: "https://kagi.com", enabled: true },
  { id: "github", name: "GitHub", url: "https://github.com/search?q=", siteUrl: "https://github.com", enabled: true },
  { id: "youtube", name: "YouTube", url: "https://www.youtube.com/results?search_query=", siteUrl: "https://www.youtube.com", enabled: true },
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
