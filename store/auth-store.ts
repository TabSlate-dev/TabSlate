import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { chromeStorageAdapter } from "@/lib/chrome-storage-adapter";
import { api } from "@/lib/api";
import type { ApiUser } from "@/lib/api";

interface AuthState {
  user: ApiUser | null;
  accessToken: string | null;
  refreshToken: string | null;
  // Server URL — defaults to the build-time env var or empty (user must enter it).
  serverUrl: string;

  _hydrated: boolean;
  setHydrated: () => void;

  setServerUrl: (url: string) => void;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      serverUrl: (import.meta.env.VITE_API_URL as string | undefined) ?? "",

      _hydrated: false,
      setHydrated: () => set({ _hydrated: true }),

      setServerUrl: (url) => set({ serverUrl: url }),

      login: async (email, password) => {
        const { serverUrl } = get();
        const resp = await api.login(serverUrl, email, password);
        set({
          user: resp.user,
          accessToken: resp.access_token,
          refreshToken: resp.refresh_token,
        });
      },

      register: async (name, email, password) => {
        const { serverUrl } = get();
        const resp = await api.register(serverUrl, name, email, password);
        set({
          user: resp.user,
          accessToken: resp.access_token,
          refreshToken: resp.refresh_token,
        });
      },

      logout: async () => {
        const { serverUrl, accessToken, refreshToken } = get();
        if (accessToken && refreshToken) {
          try {
            await api.logout(serverUrl, accessToken, refreshToken);
          } catch {
            // best-effort: clear local state regardless
          }
        }
        set({ user: null, accessToken: null, refreshToken: null });
      },
    }),
    {
      name: "tabslate-auth",
      storage: createJSONStorage(() => chromeStorageAdapter),
      onRehydrateStorage: () => (state) => {
        if (state) {
          // If no serverUrl was persisted, fall back to the build-time env var.
          if (!state.serverUrl) {
            state.serverUrl =
              (import.meta.env.VITE_API_URL as string | undefined) ?? "";
          }
          state.setHydrated();
        }
      },
      // Only persist tokens and user — not actions or _hydrated
      partialize: (state) => ({
        user: state.user,
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        serverUrl: state.serverUrl,
      }),
    },
  ),
);
