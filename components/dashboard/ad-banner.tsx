import * as React from "react";
import { ArrowRight, Sparkles, Cloud, Bot, ShieldCheck } from "lucide-react";
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

function AdCard({ ad, compact }: { ad: Ad; compact: boolean }) {
  const Icon = getAdIcon(ad.badge);

  const handleClick = () => {
    if (ad.websiteUrl) {
      window.location.href = ad.websiteUrl;
    }
  };

  return (
    <div
      className={cn(
        "relative z-0 hover:z-10 h-full rounded-2xl border border-muted/60 bg-gradient-to-br from-background/90 to-muted/40 backdrop-blur-md shadow-sm transition-all duration-500 hover:shadow-lg hover:scale-[1.02] group flex flex-col cursor-pointer",
        compact ? "p-3 2xl:p-4" : "p-4 md:p-5"
      )}
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
      {/* Outer Glow Effect (Restored and tightened) */}
      <div className={cn("absolute inset-0 bg-gradient-to-r opacity-0 group-hover:opacity-100 transition-opacity duration-500 blur-md z-[-1] rounded-2xl pointer-events-none", ad.gradient)} />

      {/* Inner Mask for clipping the background icon */}
      <div className="absolute inset-0 rounded-2xl overflow-hidden pointer-events-none z-0">
        {/* Layer 1: Soft color glow */}
        <div className="absolute -bottom-12 -right-12 opacity-30 dark:opacity-20 group-hover:opacity-50 transition-opacity duration-500">
          <Icon className={cn("w-64 h-64 blur-2xl -rotate-12", ad.iconColor)} />
        </div>
        {/* Layer 2: Crisp visible silhouette */}
        <div className="absolute -bottom-8 -right-8 opacity-[0.07] dark:opacity-[0.12] group-hover:opacity-[0.14] dark:group-hover:opacity-[0.22] transition-opacity duration-500">
          <Icon className={cn("w-52 h-52 -rotate-12", ad.iconColor)} />
        </div>
      </div>

      {/* Ad Badge */}
      <div className="absolute top-4 right-4 flex items-center gap-1 px-2.5 py-1 rounded-md bg-background/80 backdrop-blur-md border shadow-xs text-[10px] font-bold text-muted-foreground uppercase tracking-wider z-20 transition-colors group-hover:text-foreground">
        <span>{ad.badge}</span>
      </div>

      <div className="relative z-10 flex flex-col h-full">
        {/* Title and Icon inline */}
        <div className="flex items-start gap-2.5 mb-2 2xl:mb-3 pr-12">
          <div className={cn(
            "shrink-0 rounded-lg flex items-center justify-center border shadow-sm transition-transform duration-300 group-hover:scale-105 group-hover:shadow-md size-8 2xl:size-10 overflow-hidden",
            ad.gradient
          )}>
            {ad.iconUrl ? (
              <FaviconImage src={ad.iconUrl} className="size-5 2xl:size-6 object-contain" />
            ) : (
              <Icon className={cn(ad.iconColor, "size-4 2xl:size-5")} />
            )}
          </div>
          <h3 className="text-sm 2xl:text-base font-semibold tracking-tight text-foreground leading-tight mt-1 drop-shadow-sm truncate">
            {ad.title}
          </h3>
        </div>

        {/* Content */}
        <div className="flex-1 mb-2 2xl:mb-4">
          <p className="text-[11px] 2xl:text-xs text-foreground/70 leading-relaxed line-clamp-2">
            {ad.description}
          </p>
        </div>

        {/* Action hint - Fixed at bottom */}
        <div className="flex items-center justify-between mt-auto pt-2 pb-0.5">
          <span className="text-[10px] 2xl:text-[11px] font-semibold text-primary/90 group-hover:text-primary transition-colors truncate">
            {ad.action}
          </span>
          <div className="flex items-center justify-center w-4 h-4 shrink-0 ml-2">
            <ArrowRight className="size-3 text-primary/70 group-hover:text-primary group-hover:scale-110 transition-all duration-300" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function AdBanner() {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [isHovered, setIsHovered] = React.useState(false);
  const [isVisible, setIsVisible] = React.useState(true);

  const ads = useAdsStore((s) => s.homepageAds);
  const ensureFresh = useAdsStore((s) => s.ensureFresh);

  React.useEffect(() => {
    ensureFresh();
  }, [ensureFresh]);

  React.useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => setIsVisible(entries[0].isIntersecting),
      { threshold: 0 }
    );
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    return () => observer.disconnect();
  }, []);

  const isCarousel = ads.length > 1;

  // To ensure the scroll set is wider than the viewport (preventing hits to scroll boundaries
  // when ads length is very small like 2), we repeat the ads array to form a "baseSet"
  // with at least 10 items.
  const baseSet = React.useMemo(() => {
    if (!isCarousel || ads.length === 0) { return []; }
    const minLength = 10;
    const repeats = Math.ceil(minLength / ads.length);
    const result: Ad[] = [];
    for (let i = 0; i < repeats; i++) {
      result.push(...ads);
    }
    return result;
  }, [ads, isCarousel]);

  const carouselItems = isCarousel ? [...baseSet, ...baseSet, ...baseSet] : ads;

  // Initialize scroll position to the start of the middle set
  React.useEffect(() => {
    if (!isCarousel || !scrollRef.current || baseSet.length === 0) { return; }
    const timer = setTimeout(() => {
      if (scrollRef.current) {
        const firstChild = scrollRef.current.children[0];
        if (!firstChild) { return; }
        const itemWidth = firstChild.clientWidth + 16; // 16px gap
        const setWidth = itemWidth * baseSet.length;
        scrollRef.current.scrollTo({ left: setWidth, behavior: "auto" });
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [isCarousel, baseSet.length]);

  const handleScroll = React.useCallback(() => {
    if (!scrollRef.current || !isCarousel || baseSet.length === 0) { return; }
    const firstChild = scrollRef.current.children[0];
    if (!firstChild) { return; }
    const itemWidth = firstChild.clientWidth + 16;
    const setWidth = itemWidth * baseSet.length;
    const scrollLeft = scrollRef.current.scrollLeft;

    // If we've scrolled fully into the 3rd set, jump back to the 2nd set instantly
    if (scrollLeft >= setWidth * 2) {
      scrollRef.current.scrollTo({ left: scrollLeft - setWidth, behavior: "auto" });
    }
    // If we've scrolled fully backwards into the 1st set (to the very start), jump forward to the 2nd set instantly
    else if (scrollLeft <= 0) {
      scrollRef.current.scrollTo({ left: scrollLeft + setWidth, behavior: "auto" });
    }
  }, [isCarousel, baseSet.length]);

  // Smooth continuous auto-scroll
  React.useEffect(() => {
    if (!isCarousel || isHovered || !isVisible || baseSet.length === 0) { return; }

    let animationFrameId: number;
    let lastTimestamp: number = 0;
    let paused = document.hidden;
    const speedPixelsPerMs = 0.05;

    const onVisibilityChange = () => { paused = document.hidden; };
    document.addEventListener("visibilitychange", onVisibilityChange);

    const animate = (timestamp: number) => {
      if (paused) {
        lastTimestamp = timestamp;
        animationFrameId = requestAnimationFrame(animate);
        return;
      }

      if (!lastTimestamp) { lastTimestamp = timestamp; }
      const deltaTime = timestamp - lastTimestamp;

      if (scrollRef.current && deltaTime > 0) {
        const firstChild = scrollRef.current.children[0];
        if (firstChild) {
          scrollRef.current.scrollLeft += speedPixelsPerMs * deltaTime;

          const itemWidth = firstChild.clientWidth + 16;
          const setWidth = itemWidth * baseSet.length;
          if (scrollRef.current.scrollLeft >= setWidth * 2) {
            scrollRef.current.scrollLeft -= setWidth;
          }
        }
      }

      lastTimestamp = timestamp;
      animationFrameId = requestAnimationFrame(animate);
    };

    animationFrameId = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(animationFrameId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [isCarousel, isHovered, isVisible, baseSet.length]);

  if (ads.length === 0) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className="w-full max-w-[1400px] mt-4 relative"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Left Edge Mask */}
      {isCarousel && (
        <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-8 md:w-24 bg-gradient-to-r from-background to-transparent z-20" />
      )}

      {/* Right Edge Mask */}
      {isCarousel && (
        <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-8 md:w-24 bg-gradient-to-l from-background to-transparent z-20" />
      )}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex overflow-x-auto gap-4 pt-4 pb-4 px-4 md:px-8 [&::-webkit-scrollbar]:hidden"
        style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
      >
        {carouselItems.map((ad, idx) => (
          <div
            key={`${ad.id}-${idx}`}
            className={cn(
              "shrink-0 transition-all w-[calc(100vw-2.5rem)] sm:w-[260px] md:w-[280px] lg:w-[320px] 2xl:w-[360px] h-32 lg:h-36 2xl:h-40",
              !isCarousel && "mx-auto"
            )}
          >
            <AdCard ad={ad} compact={true} />
          </div>
        ))}
      </div>
    </div>
  );
}
