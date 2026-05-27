import * as React from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useI18nStore, SupportedLanguage } from "@/store/i18n-store";

export function LanguageSelector() {
  const language = useI18nStore((s) => s.language);
  const setLanguage = useI18nStore((s) => s.setLanguage);

  const handleSelect = (lang: SupportedLanguage) => {
    setLanguage(lang);
  };

  const currentLabel = React.useMemo(() => {
    if (language === "en") return "🇺🇸 English";
    if (language === "zh_CN") return "🇨🇳 简体中文";
    return "🌐 Auto";
  }, [language]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 gap-2 px-2 text-muted-foreground font-normal">
          {currentLabel}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => handleSelect("auto")}>
          <span className={language === "auto" ? "font-bold" : ""}>🌐 Auto (Browser Default)</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleSelect("en")}>
          <span className={language === "en" ? "font-bold" : ""}>🇺🇸 English</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleSelect("zh_CN")}>
          <span className={language === "zh_CN" ? "font-bold" : ""}>🇨🇳 简体中文</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
