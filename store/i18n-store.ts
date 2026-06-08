import { create } from "zustand";
import { persist } from "zustand/middleware";
import { browser } from "wxt/browser";

export type SupportedLanguage = "auto" | "en" | "zh_CN";

interface I18nState {
  language: SupportedLanguage;
  messages: Record<string, { message: string }> | null;
  isHydrated: boolean;
  setLanguage: (lang: SupportedLanguage) => Promise<void>;
  _hasHydrated: () => void;
}

export function resolveAcceptLanguage(lang: SupportedLanguage): string {
  if (lang === "zh_CN") return "zh-CN";
  if (lang === "en") return "en";
  return navigator.language;
}

export const useI18nStore = create<I18nState>()(
  persist(
    (set, get) => ({
      language: "auto",
      messages: null,
      isHydrated: false,
      setLanguage: async (lang) => {
        if (lang === "auto") {
          set({ language: lang, messages: null });
          return;
        }
        
        try {
          const url = browser.runtime.getURL(`_locales/${lang}/messages.json` as any);
          const response = await fetch(url);
          const data = await response.json();
          set({ language: lang, messages: data });
        } catch (err) {
          console.error(`Failed to load locales for ${lang}:`, err);
          // Fallback to auto if loading fails
          set({ language: "auto", messages: null });
        }
      },
      _hasHydrated: () => {
        set({ isHydrated: true });
      }
    }),
    {
      name: "tabslate-i18n",
      onRehydrateStorage: () => (state) => {
        if (state) {
          // Re-fetch the language file on load to ensure it's up to date
          // if a specific language is set.
          if (state.language !== "auto") {
            state.setLanguage(state.language).then(() => {
              state._hasHydrated();
            });
          } else {
            state._hasHydrated();
          }
        }
      },
    }
  )
);
