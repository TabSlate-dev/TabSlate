import { useI18nStore } from "@/store/i18n-store";
import { browser } from "wxt/browser";
import { useCallback } from "react";

export function useTranslation() {
  const language = useI18nStore((s) => s.language);
  const messages = useI18nStore((s) => s.messages);

  const t = useCallback((key: string, substitutions?: string | string[]) => {
    // If user has overridden the language and messages are loaded
    if (language !== "auto" && messages && messages[key]) {
      let text = messages[key].message;
      if (substitutions) {
        const subs = Array.isArray(substitutions) ? substitutions : [substitutions];
        subs.forEach((sub, index) => {
          text = text.replace(`$${index + 1}`, sub);
        });
      }
      return text;
    }

    // Fallback to native chrome.i18n
    const nativeTranslation = browser.i18n.getMessage(key as any, substitutions);
    return nativeTranslation || key;
  }, [language, messages]);

  return { t, language };
}
