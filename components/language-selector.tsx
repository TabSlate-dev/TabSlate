import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Languages } from "lucide-react";
import { useI18nStore, SupportedLanguage } from "@/store/i18n-store";

export function LanguageSelector() {
  const language = useI18nStore((s) => s.language);
  const setLanguage = useI18nStore((s) => s.setLanguage);

  const handleSelect = (lang: SupportedLanguage) => {
    setLanguage(lang);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8">
          <Languages className="h-4 w-4 text-muted-foreground" />
          <span className="sr-only">Toggle language</span>
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
