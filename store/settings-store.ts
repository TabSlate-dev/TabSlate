import { create } from "zustand";

interface SettingsState {
  _hydrated: boolean;
  hydrate: () => Promise<void>;
  reset: () => void;
  pullFromServer: (serverUrl: string, accessToken: string) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  _hydrated: false,
  hydrate: async () => { set({ _hydrated: true }); },
  reset: () => { set({ _hydrated: true }); },
  pullFromServer: async () => { /* no user preferences to pull currently */ },
}));
