import * as React from "react";
import { ArrowRight, Sparkles, Cloud, Bot, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  return (
    <div className={cn(
      "relative h-full overflow-hidden rounded-2xl border border-muted/60 bg-gradient-to-br from-background/80 to-muted/30 backdrop-blur-md shadow-sm transition-all hover:shadow-md group flex",
      compact ? "flex-col p-5" : "flex-col md:flex-row p-5 md:p-6 items-center gap-6"
    )}>
      {/* Subtle background glow effect */}
      <div className={cn("absolute -inset-0.5 bg-gradient-to-r opacity-0 group-hover:opacity-100 transition-opacity duration-500 blur-xl z-0", ad.gradient)} />
      
      {/* Ad Badge */}
      <div className="absolute top-3 right-3 flex items-center gap-1 px-2 py-1 rounded-md bg-muted/80 backdrop-blur-md text-[10px] font-medium text-muted-foreground uppercase tracking-widest z-20">
        <span>{ad.badge}</span>
      </div>

      <div className={cn(
        "relative z-10 flex",
        compact ? "flex-col items-start w-full" : "flex-col md:flex-row items-center w-full"
      )}>
        {/* Visual element */}
        <div className={cn(
          "shrink-0 rounded-xl bg-gradient-to-tr flex items-center justify-center border border-primary/10 shadow-inner",
          ad.gradient,
          compact ? "size-12 mb-4" : "size-16 md:size-20 mb-4 md:mb-0 md:mr-6"
        )}>
          <Icon className={cn(ad.iconColor, compact ? "size-6" : "size-8 md:size-10")} />
        </div>

        {/* Content */}
        <div className={cn(
          "flex-1",
          compact ? "space-y-1.5 w-full" : "space-y-2 text-center md:text-left"
        )}>
          <h3 className="text-base md:text-lg font-semibold tracking-tight text-foreground flex items-center justify-center md:justify-start gap-2">
            {ad.title}
          </h3>
          <p className={cn(
            "text-sm text-muted-foreground leading-relaxed",
            compact ? "line-clamp-2" : "max-w-xl"
          )}>
            {ad.description}
          </p>
        </div>
      </div>

      {/* Action */}
      <div className={cn(
        "relative z-10 shrink-0",
        compact ? "w-full mt-auto pt-5" : "w-full md:w-auto mt-4 md:mt-0"
      )}>
        <Button size={compact ? "sm" : "default"} className="w-full md:w-auto rounded-xl shadow-sm hover:shadow transition-all group/btn">
          <span>{ad.action}</span>
          <ArrowRight className="ml-2 size-4 transition-transform group-hover/btn:translate-x-1" />
        </Button>
      </div>
    </div>
  );
}

export function AdBanner() {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [isHovered, setIsHovered] = React.useState(false);

  const originalItems = ADS;
  const isCarousel = originalItems.length > 1;
  // Triplicate the items so we can create a seamless infinite scroll effect
  const items = isCarousel ? [...originalItems, ...originalItems, ...originalItems] : originalItems;

  // Initialize scroll position to the start of the middle set
  React.useEffect(() => {
    if (!isCarousel || !scrollRef.current) return;
    // Small delay to ensure layout is calculated and cards have width
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

  React.useEffect(() => {
    if (!isCarousel || isHovered) return;
    const timer = setInterval(() => {
      if (scrollRef.current) {
        const itemWidth = scrollRef.current.children[0].clientWidth + 16;
        const setWidth = itemWidth * originalItems.length;
        const scrollLeft = scrollRef.current.scrollLeft;
        
        // Preemptively check if the next smooth scroll will hit the end boundary
        if (scrollLeft + itemWidth >= setWidth * 2) {
          // Instantly jump back one set length
          scrollRef.current.scrollTo({ left: scrollLeft - setWidth, behavior: "auto" });
          // Wait for the DOM to update, then apply the smooth scroll
          requestAnimationFrame(() => {
            scrollRef.current?.scrollBy({ left: itemWidth, behavior: "smooth" });
          });
        } else {
          scrollRef.current.scrollBy({ left: itemWidth, behavior: "smooth" });
        }
      }
    }, 4000); // cycle every 4s
    return () => clearInterval(timer);
  }, [isCarousel, isHovered, originalItems.length]);

  return (
    <div 
      className="w-full max-w-[1400px] mt-8 relative"
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
        className="flex overflow-x-auto snap-x snap-mandatory gap-4 pb-4 px-4 md:px-8 [&::-webkit-scrollbar]:hidden"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {items.map((ad, idx) => (
          <div 
            key={`${ad.id}-${idx}`} 
            className={cn(
              "snap-start shrink-0 h-auto transition-all",
              !isCarousel 
                ? "w-full max-w-3xl mx-auto" 
                : "w-[calc(100vw-2.5rem)] sm:w-[340px] md:w-[420px]"
            )}
          >
            <AdCard ad={ad} compact={isCarousel} />
          </div>
        ))}
      </div>
    </div>
  );
}
