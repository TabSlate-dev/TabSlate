import * as React from "react";
import { ArrowRight, Sparkles, Bot, ShieldCheck, Cloud } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAdsStore, type Ad } from "@/store/ads-store";
import { FaviconImage } from "@/components/ui/favicon-image";

const getAdIcon = (badge: string) => {
  const normalized = badge.toLowerCase().trim();
  if (normalized === "sponsor" || normalized === "pro") { return Sparkles; }
  if (normalized === "ad" || normalized === "offer") { return Cloud; }
  if (normalized === "new" || normalized === "featured") { return Bot; }
  if (normalized === "trending") { return ShieldCheck; }
  return Sparkles;
};

function StripAdCard({ ad, vertical }: { ad: Ad; vertical?: boolean }) {
  const Icon = getAdIcon(ad.badge);

  const handleClick = () => {
    if (ad.websiteUrl) {
      window.open(ad.websiteUrl, "_blank", "noopener,noreferrer");
    }
  };

  if (vertical) {
    return (
      <div
        className="relative z-0 flex items-center overflow-hidden rounded-lg border border-muted/60 bg-gradient-to-br from-background/90 to-muted/40 backdrop-blur-md shadow-sm transition-all duration-300 hover:shadow-md hover:border-primary/30 group cursor-pointer px-2.5 py-2 gap-2.5"
        onClick={handleClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleClick();
          }
        }}
      >
        {/* Outer glow */}
        <div className={cn("absolute inset-0 bg-gradient-to-r opacity-0 group-hover:opacity-100 transition-opacity duration-500 blur-md z-[-1] rounded-lg pointer-events-none", ad.gradient)} />
        {/* Icon */}
        <div className={cn("shrink-0 size-7 rounded-md flex items-center justify-center border shadow-sm transition-transform duration-300 group-hover:scale-110 z-10 overflow-hidden", ad.gradient)}>
          {ad.iconUrl ? (
            <FaviconImage src={ad.iconUrl} className="size-4.5 object-contain" />
          ) : (
            <Icon className={cn(ad.iconColor, "size-3.5")} />
          )}
        </div>
        {/* Text */}
        <div className="flex-1 min-w-0 z-10">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-foreground truncate">{ad.title}</span>
            <span className="shrink-0 px-1 py-0.5 rounded text-[8px] font-bold bg-background/80 border text-muted-foreground uppercase tracking-wide">{ad.badge}</span>
          </div>
          <p className="text-[10px] text-foreground/50 truncate mt-0.5">{ad.description}</p>
        </div>
        {/* Arrow */}
        <ArrowRight className="size-3 shrink-0 text-muted-foreground/40 group-hover:text-primary group-hover:translate-x-0.5 transition-all duration-300 z-10" />
      </div>
    );
  }

  return (
    <div
      className="relative z-0 flex flex-col overflow-hidden rounded-xl border border-muted/60 bg-gradient-to-br from-background/90 to-muted/40 backdrop-blur-md shadow-sm transition-all duration-500 hover:shadow-lg hover:border-primary/30 hover:-translate-y-0.5 group cursor-pointer p-4"
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      }}
    >
      {/* Outer glow */}
      <div className={cn("absolute inset-0 bg-gradient-to-r opacity-0 group-hover:opacity-100 transition-opacity duration-500 blur-md z-[-1] rounded-xl pointer-events-none", ad.gradient)} />
      {/* Background icon watermark */}
      <div className="absolute inset-0 overflow-hidden rounded-xl pointer-events-none z-0">
        <div className="absolute -bottom-4 -right-4 opacity-20 dark:opacity-10 group-hover:opacity-35 transition-opacity duration-500">
          <Icon className={cn("w-20 h-20 blur-[6px] -rotate-12", ad.iconColor)} />
        </div>
      </div>
      {/* Badge */}
      <div className="absolute top-3 right-3 px-1.5 py-0.5 rounded bg-background/80 backdrop-blur-md border text-[9px] font-bold text-muted-foreground uppercase tracking-wider z-20 group-hover:text-foreground transition-colors">
        {ad.badge}
      </div>
      {/* Content */}
      <div className="relative z-10 flex flex-col gap-2">
        <div className="flex items-center gap-2.5 pr-8">
          <div className={cn("shrink-0 size-8 rounded-lg flex items-center justify-center border shadow-sm transition-transform duration-300 group-hover:scale-110 overflow-hidden", ad.gradient)}>
            {ad.iconUrl ? (
              <FaviconImage src={ad.iconUrl} className="size-5 object-contain" />
            ) : (
              <Icon className={cn(ad.iconColor, "size-4")} />
            )}
          </div>
          <span className="text-sm font-semibold text-foreground leading-tight line-clamp-1">{ad.title}</span>
        </div>
        <p className="text-[11px] text-foreground/60 leading-relaxed line-clamp-2">{ad.description}</p>
        <button className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-primary hover:text-primary/80 transition-colors w-fit group/btn">
          {ad.action}
          <ArrowRight className="size-3 transition-transform duration-300 group-hover/btn:translate-x-0.5" />
        </button>
      </div>
    </div>
  );
}

export function TabsAdStrip({ vertical }: { vertical?: boolean }) {
  const ads = useAdsStore((s) => s.ads);
  const ensureFresh = useAdsStore((s) => s.ensureFresh);

  React.useEffect(() => {
    ensureFresh();
  }, [ensureFresh]);

  if (ads.length === 0) {
    return null;
  }

  // Limit to first 3 ads for vertical, first 4 for horizontal to avoid clutter
  const adsToShow = vertical ? ads.slice(0, 3) : ads.slice(0, 4);

  return (
    <div className={cn(vertical ? "flex flex-col gap-2" : "grid grid-cols-3 gap-3")}>
      {adsToShow.map((ad) => (
        <StripAdCard key={ad.id} ad={ad} vertical={vertical} />
      ))}
    </div>
  );
}
