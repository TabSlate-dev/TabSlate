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
  // Unix ms timestamp of the last successful OTP send (register or resend).
  // Used by VerifyEmailScreen to compute the remaining cooldown on mount
  // without needing an extra API call.
  otpSentAt: number | null;

  _hydrated: boolean;
  setHydrated: () => void;

  setServerUrl: (url: string) => void;
  login: (
    email: string,
    password: string,
    captchaToken?: string,
  ) => Promise<void>;
  register: (
    name: string,
    email: string,
    password: string,
    captchaToken?: string,
  ) => Promise<void>;
  resendVerification: (email: string, captchaToken?: string) => Promise<void>;
  verifyEmailOTP: (email: string, code: string) => Promise<void>;
  forgotPassword: (email: string, captchaToken?: string) => Promise<void>;
  resetPassword: (email: string, code: string, newPassword: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      serverUrl: (import.meta.env.VITE_API_URL as string | undefined) ?? "",
      otpSentAt: null,

      _hydrated: false,
      setHydrated: () => set({ _hydrated: true }),

      setServerUrl: (url) => set({ serverUrl: url }),

      login: async (email, password, captchaToken) => {
        const { serverUrl } = get();
        const resp = await api.login(serverUrl, email, password, captchaToken);
        set({
          user: resp.user,
          accessToken: resp.access_token,
          refreshToken: resp.refresh_token,
        });
      },

      register: async (name, email, password, captchaToken) => {
        const { serverUrl } = get();
        const resp = await api.register(
          serverUrl,
          name,
          email,
          password,
          captchaToken,
        );
        set({
          user: resp.user,
          accessToken: resp.access_token,
          refreshToken: resp.refresh_token,
          otpSentAt: Date.now(),
        });
      },

      resendVerification: async (email, captchaToken) => {
        const { serverUrl } = get();
        await api.resendVerification(serverUrl, email, captchaToken);
        set({ otpSentAt: Date.now() });
      },

      verifyEmailOTP: async (email, code) => {
        const { serverUrl, accessToken } = get();
        await api.verifyEmailOTP(serverUrl, email, code);
        // Re-fetch user from the server so is_verified reflects the backend state.
        if (accessToken) {
          const resp = await api.me(serverUrl, accessToken);
          set({ user: resp.user });
        }
      },

      forgotPassword: async (email, captchaToken) => {
        const { serverUrl } = get();
        await api.forgotPassword(serverUrl, email, captchaToken);
      },

      resetPassword: async (email, code, newPassword) => {
        const { serverUrl } = get();
        await api.resetPassword(serverUrl, email, code, newPassword);
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
        otpSentAt: state.otpSentAt,
      }),
    },
  ),
);
