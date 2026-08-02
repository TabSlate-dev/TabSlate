import { useI18nStore } from "@/store/i18n-store";
import { browser } from "wxt/browser";
import { createElement, useCallback, type ReactNode } from "react";

export function useTranslation() {
  const language = useI18nStore((s) => s.language);
  const messages = useI18nStore((s) => s.messages);

  const rawMessage = useCallback((key: string) => {
    if (language !== "auto" && messages && messages[key]) {
      return messages[key].message;
    }
    return browser.i18n.getMessage(key as any) || key;
  }, [language, messages]);

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

  // Splits the translation on the $1 placeholder and interpolates a real
  // React node instead of building an HTML string (avoids innerHTML use).
  const tNode = useCallback((key: string, node: ReactNode): ReactNode => {
    const [before, after] = rawMessage(key).split("$1");
    return createElement("span", null, before, node, after);
  }, [rawMessage]);

  return { t, tNode, language };
}
