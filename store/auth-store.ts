import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { authStorageAdapter } from "@/lib/auth-storage-adapter";
import { api, ApiError } from "@/lib/api";
import { useI18nStore, resolveAcceptLanguage } from "@/store/i18n-store";
import type { ApiUser } from "@/lib/api";
import { clearDB } from "@/lib/idb";
import { clearSyncRecoverySnapshot } from "@/lib/sync-recovery";

let _refreshPromise: Promise<boolean> | null = null;
let _refreshRetryTimer: ReturnType<typeof setTimeout> | null = null;
let _refreshRetryDelay = 2000;
let _authSessionGeneration = 0;
const MAX_REFRESH_RETRY_DELAY = 60_000;

function clearRefreshRetry() {
  if (_refreshRetryTimer) {
    clearTimeout(_refreshRetryTimer);
    _refreshRetryTimer = null;
  }
  _refreshRetryDelay = 2000;
}

function invalidateRefreshWork() {
  _authSessionGeneration += 1;
  _refreshPromise = null;
  clearRefreshRetry();
}

function scheduleRefreshRetry() {
  if (_refreshRetryTimer) { return; }
  _refreshRetryTimer = setTimeout(() => {
    _refreshRetryTimer = null;
    _refreshRetryDelay = Math.min(_refreshRetryDelay * 2, MAX_REFRESH_RETRY_DELAY);
    void useAuthStore.getState().silentRefresh();
  }, _refreshRetryDelay);
}

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
  silentRefresh: () => Promise<boolean>;
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
  requestAccountDeletion: (password: string) => Promise<{ scheduled_at: number; executes_at: number }>;
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

      silentRefresh: async () => {
        if (_refreshPromise) {
          return _refreshPromise;
        }

        const { serverUrl, refreshToken } = get();
        if (!refreshToken) {
          return false;
        }

        const refreshGeneration = _authSessionGeneration;
        let refreshPromise: Promise<boolean> | null = null;
        refreshPromise = (async () => {
          try {
            const resp = await api.refresh(serverUrl, refreshToken);
            if (refreshGeneration !== _authSessionGeneration) {
              return false;
            }
            clearRefreshRetry();
            set({
              accessToken: resp.access_token,
              refreshToken: resp.refresh_token,
              user: resp.user,
            });
            return true;
          } catch (err) {
            if (refreshGeneration !== _authSessionGeneration) {
              return false;
            }
            if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
              clearRefreshRetry();
              clearSyncRecoverySnapshot();
              set({
                user: null,
                accessToken: null,
                refreshToken: null,
                otpSentAt: null,
              });
              return false;
            }

            scheduleRefreshRetry();
            return false;
          } finally {
            if (_refreshPromise === refreshPromise) {
              _refreshPromise = null;
            }
          }
        })();
        _refreshPromise = refreshPromise;

        return refreshPromise;
      },

      login: async (email, password, captchaToken) => {
        invalidateRefreshWork();
        const { serverUrl, otpSentAt } = get();
        const lang = resolveAcceptLanguage(useI18nStore.getState().language);
        const resp = await api.login(serverUrl, email, password, captchaToken, lang);
        // If the user is unverified, the server auto-sends an OTP when the
        // 60s cooldown has elapsed. Mirror that here so VerifyEmailScreen
        // shows the correct countdown on mount.
        let newOtpSentAt = otpSentAt;
        if (!resp.user.is_verified) {
          const elapsed = otpSentAt ? (Date.now() - otpSentAt) / 1000 : Infinity;
          if (elapsed >= 60) {
            newOtpSentAt = Date.now();
          }
        }
        set({
          user: resp.user,
          accessToken: resp.access_token,
          refreshToken: resp.refresh_token,
          otpSentAt: newOtpSentAt,
        });
      },

      register: async (name, email, password, captchaToken) => {
        invalidateRefreshWork();
        const { serverUrl } = get();
        const lang = resolveAcceptLanguage(useI18nStore.getState().language);
        const resp = await api.register(
          serverUrl,
          name,
          email,
          password,
          captchaToken,
          lang,
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
        const lang = resolveAcceptLanguage(useI18nStore.getState().language);
        await api.resendVerification(serverUrl, email, captchaToken, lang);
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
        const lang = resolveAcceptLanguage(useI18nStore.getState().language);
        await api.forgotPassword(serverUrl, email, captchaToken, lang);
      },

      resetPassword: async (email, code, newPassword) => {
        const { serverUrl } = get();
        await api.resetPassword(serverUrl, email, code, newPassword);
      },

      requestAccountDeletion: async (password) => {
        const { serverUrl, accessToken } = get();
        if (!accessToken) throw new Error("not authenticated");
        const result = await api.deleteAccount(serverUrl, accessToken, password);
        // Refresh user so deletion_scheduled_at is populated in UI.
        const me = await api.me(serverUrl, accessToken);
        set({ user: me.user });
        return result;
      },

      logout: async () => {
        const { serverUrl, accessToken, refreshToken } = get();
        invalidateRefreshWork();
        clearSyncRecoverySnapshot();
        if (accessToken && refreshToken) {
          try {
            await api.logout(serverUrl, accessToken, refreshToken);
          } catch {
            // best-effort: clear local state regardless
          }
        }
        await clearDB();
        chrome.storage.local.remove("tabslate-search-engines");
        set({ user: null, accessToken: null, refreshToken: null, otpSentAt: null });
      },
    }),
    {
      name: "tabslate-auth",
      storage: createJSONStorage(() => authStorageAdapter),
      onRehydrateStorage: () => (state) => {
        if (!state) {
          return;
        }

        if (!state.serverUrl) {
          state.serverUrl =
            (import.meta.env.VITE_API_URL as string | undefined) ?? "";
        }

        state.setHydrated();

        if (state.refreshToken && !state.accessToken) {
          void state.silentRefresh();
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
