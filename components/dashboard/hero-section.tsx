import * as React from "react";
import { AdBanner } from "@/components/dashboard/ad-banner";
import { SearchBox } from "./search-box";
import { useTranslation } from "@/hooks/use-translation";

function Clock() {
  const { language } = useTranslation();
  const [time, setTime] = React.useState(new Date());

  React.useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const localeCode = language === "zh_CN" ? "zh-CN" : "en-US";
  const formattedTime = time.toLocaleTimeString(localeCode, { hour: '2-digit', minute: '2-digit', hour12: false });
  const formattedDate = time.toLocaleDateString(localeCode, { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase();

  return (
    <div className="text-center space-y-2">
      <h1 className="text-6xl md:text-8xl font-bold tracking-tighter text-foreground">
        {formattedTime}
      </h1>
      <p className="text-sm md:text-base font-medium text-muted-foreground tracking-widest">
        {formattedDate}
      </p>
    </div>
  );
}

export function HeroSection() {
  return (
    <div className="flex flex-col items-center justify-center pt-8 md:pt-12 pb-2 md:pb-4 space-y-6 md:space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
      <Clock />
      <SearchBox size="lg" className="w-full max-w-3xl px-4" />
      <AdBanner />
    </div>
  );
}
