import * as React from "react";
import { ArrowRight, Sparkles, Cloud, Bot, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

const ADS = [
  {
    id: 1,
    title: "TabSlate Premium",
    description: "Unlock advanced AI organization, cloud sync, and custom themes.",
    badge: "Sponsor",
    icon: Sparkles,
    action: "Learn More",
    gradient: "from-primary/20 to-purple-500/20",
    iconColor: "text-primary/80"
  },
  {
    id: 2,
    title: "Cloud Sync Pro",
    description: "Never lose a tab again. Securely sync across all your devices seamlessly.",
    badge: "Ad",
    icon: Cloud,
    action: "Try Free",
    gradient: "from-blue-500/20 to-cyan-500/20",
    iconColor: "text-blue-500/80"
  },
  {
    id: 3,
    title: "AI Assistant",
    description: "Let AI automatically group and organize your tabs intelligently based on context.",
    badge: "New",
    icon: Bot,
    action: "Explore",
    gradient: "from-emerald-500/20 to-teal-500/20",
    iconColor: "text-emerald-500/80"
  },
  {
    id: 4,
    title: "Privacy Shield",
    description: "Enterprise-grade security and end-to-end encryption for your browser data.",
    badge: "Offer",
    icon: ShieldCheck,
    action: "Get Started",
    gradient: "from-rose-500/20 to-orange-500/20",
    iconColor: "text-rose-500/80"
  },
  {
    id: 5,
    title: "Web3 Wallet Integration",
    description: "Connect your favorite wallets and manage your digital assets securely right from your new tab.",
    badge: "Sponsor",
    icon: Sparkles,
    action: "Connect Wallet",
    gradient: "from-amber-500/20 to-yellow-500/20",
    iconColor: "text-amber-500/80"
  },
  {
    id: 6,
    title: "Developer Tools Pack",
    description: "Essential shortcuts and widgets for developers. JSON formatter, color picker, and more.",
    badge: "Featured",
    icon: Bot,
    action: "Install Pack",
    gradient: "from-indigo-500/20 to-blue-500/20",
    iconColor: "text-indigo-500/80"
  },
  {
    id: 7,
    title: "Dark Mode Ultimate",
    description: "Save your eyes with deep blacks and reduced blue light. Perfectly tuned for night owls.",
    badge: "Trending",
    icon: ShieldCheck,
    action: "Enable Dark",
    gradient: "from-slate-500/20 to-zinc-500/20",
    iconColor: "text-slate-500/80"
  },
  {
    id: 8,
    title: "Tab Analytics",
    description: "Understand your browsing habits. Get weekly reports on where you spend your time online.",
    badge: "Pro",
    icon: Cloud,
    action: "View Stats",
    gradient: "from-pink-500/20 to-rose-500/20",
    iconColor: "text-pink-500/80"
  }
];

function AdCard({ ad, compact }: { ad: typeof ADS[0]; compact: boolean }) {
  const Icon = ad.icon;
  
  const handleClick = () => {
    // Handle ad click action here
    console.log(`Ad clicked: ${ad.title} - ${ad.action}`);
  };
  
  return (
    <div 
      className={cn(
        "relative z-0 h-full rounded-2xl border border-muted/60 bg-gradient-to-br from-background/90 to-muted/40 backdrop-blur-md shadow-sm transition-all duration-500 hover:shadow-lg hover:scale-[1.02] group flex flex-col cursor-pointer",
        compact ? "p-4" : "p-4 md:p-5"
      )}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
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
        <div className="flex items-start gap-2.5 mb-3 pr-12">
          <div className={cn(
            "shrink-0 rounded-lg flex items-center justify-center border shadow-sm transition-transform duration-300 group-hover:scale-105 group-hover:shadow-md",
            ad.gradient,
            "size-10"
          )}>
            <Icon className={cn(ad.iconColor, "size-5")} />
          </div>
          <h3 className="text-sm md:text-base font-semibold tracking-tight text-foreground leading-tight mt-1 drop-shadow-sm truncate">
            {ad.title}
          </h3>
        </div>

        {/* Content */}
        <div className="flex-1 mb-4">
          <p className="text-xs text-foreground/70 leading-relaxed line-clamp-2">
            {ad.description}
          </p>
        </div>

        {/* Action hint - Fixed at bottom */}
        <div className="flex items-center justify-between mt-auto pt-2 pb-0.5">
          <span className="text-[11px] font-semibold text-primary/90 group-hover:text-primary transition-colors truncate">
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

  const originalItems = ADS;
  const isCarousel = originalItems.length > 1;
  // Triplicate the items so we can create a seamless infinite scroll effect
  const items = isCarousel ? [...originalItems, ...originalItems, ...originalItems] : originalItems;

  // Initialize scroll position to the start of the middle set
  React.useEffect(() => {
    if (!isCarousel || !scrollRef.current) return;
    const timer = setTimeout(() => {
      if (scrollRef.current) {
        const itemWidth = scrollRef.current.children[0].clientWidth + 16; // 16px gap
        const setWidth = itemWidth * originalItems.length;
        scrollRef.current.scrollTo({ left: setWidth, behavior: "auto" });
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [isCarousel, originalItems.length]);

  const handleScroll = React.useCallback(() => {
    if (!scrollRef.current || !isCarousel) return;
    const itemWidth = scrollRef.current.children[0].clientWidth + 16;
    const setWidth = itemWidth * originalItems.length;
    const scrollLeft = scrollRef.current.scrollLeft;

    // If we've scrolled fully into the 3rd set, jump back to the 2nd set instantly
    if (scrollLeft >= setWidth * 2) {
      scrollRef.current.scrollTo({ left: scrollLeft - setWidth, behavior: "auto" });
    }
    // If we've scrolled fully backwards into the 1st set (to the very start), jump forward to the 2nd set instantly
    else if (scrollLeft <= 0) {
      scrollRef.current.scrollTo({ left: scrollLeft + setWidth, behavior: "auto" });
    }
  }, [isCarousel, originalItems.length]);

  // Smooth continuous auto-scroll
  React.useEffect(() => {
    if (!isCarousel || isHovered || !isVisible) return;
    
    let animationFrameId: number;
    let lastTimestamp: number = 0;
    const speedPixelsPerMs = 0.05; // Adjust this to control scroll speed

    const animate = (timestamp: number) => {
      if (document.hidden) {
        lastTimestamp = timestamp;
        animationFrameId = requestAnimationFrame(animate);
        return;
      }
      
      if (!lastTimestamp) lastTimestamp = timestamp;
      const deltaTime = timestamp - lastTimestamp;
      
      if (scrollRef.current && deltaTime > 0) {
        // Move by fraction based on time elapsed
        scrollRef.current.scrollLeft += speedPixelsPerMs * deltaTime;
        
        // Let handleScroll deal with the wrapping, or do it here
        const itemWidth = scrollRef.current.children[0].clientWidth + 16;
        const setWidth = itemWidth * originalItems.length;
        if (scrollRef.current.scrollLeft >= setWidth * 2) {
          scrollRef.current.scrollLeft -= setWidth;
        }
      }
      
      lastTimestamp = timestamp;
      animationFrameId = requestAnimationFrame(animate);
    };

    animationFrameId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrameId);
  }, [isCarousel, isHovered, originalItems.length]);

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
        className="flex overflow-x-auto gap-4 pb-4 px-4 md:px-8 [&::-webkit-scrollbar]:hidden"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {items.map((ad, idx) => (
          <div 
            key={`${ad.id}-${idx}`} 
            className={cn(
              "shrink-0 transition-all",
              !isCarousel 
                ? "w-full max-w-3xl mx-auto h-44" 
                : "w-[calc(100vw-2.5rem)] sm:w-[300px] md:w-[360px] h-40"
            )}
          >
            <AdCard ad={ad} compact={isCarousel} />
          </div>
        ))}
      </div>
    </div>
  );
}
