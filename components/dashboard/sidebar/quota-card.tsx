import * as React from "react";
import {
  Award,
  Bookmark,
  Folder,
  Tag,
  Monitor,
  Sparkles,
  Zap,
  ArrowUpRight
} from "lucide-react";
import { usePlanStore } from "@/store/plan-store";
import { cn } from "@/lib/utils";

export function QuotaCard() {
  const subscription = usePlanStore((s) => s.subscription);
  const limits = usePlanStore((s) => s.limits);
  const usage = usePlanStore((s) => s.usage);
  const ensureFresh = usePlanStore((s) => s.ensureFresh);

  const [mounted, setMounted] = React.useState(false);
  const [isHovered, setIsHovered] = React.useState(false);

  React.useEffect(() => {
    ensureFresh();
    const timer = setTimeout(() => setMounted(true), 100);
    return () => clearTimeout(timer);
  }, [ensureFresh]);

  if (!limits || !usage) return null;

  const plan = subscription?.plan ?? "free";
  const AmbientIcon = plan === "free" ? Bookmark : plan === "pro" ? Zap : Sparkles;
  const iconColor = plan === "free" ? "text-muted-foreground" : plan === "pro" ? "text-primary" : "text-foreground";

  const cardStyles = React.useMemo(() => {
    if (plan === "free") {
      return {
        className:
          "border border-slate-200 dark:border-zinc-800/80 hover:border-slate-300 dark:hover:border-zinc-700 bg-gradient-to-br from-slate-100/90 via-slate-50/90 to-slate-200/90 dark:from-zinc-800/90 dark:via-zinc-900/90 dark:to-black/90 shadow-sm transition-all duration-500 hover:shadow-md hover:scale-[1.01]",
        glow: "from-slate-400/30 via-slate-300/20 to-zinc-400/20 dark:from-slate-500/20 dark:via-slate-500/10 dark:to-zinc-500/10",
        badge: "bg-slate-200/50 text-slate-600 border-slate-200 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700",
        badgeText: "Free Plan",
        progressColor: "bg-slate-300 dark:bg-zinc-600",
        iconColorClass: "text-slate-500 dark:text-zinc-400",
      };
    }
    if (plan === "pro") {
      return {
        className:
          "border border-indigo-200/60 dark:border-indigo-900/40 hover:border-indigo-300 dark:hover:border-indigo-800 bg-gradient-to-br from-indigo-100/90 via-purple-50/90 to-blue-100/90 dark:from-indigo-500/20 dark:via-purple-500/10 dark:to-blue-500/20 shadow-sm transition-all duration-500 hover:shadow-md hover:scale-[1.01]",
        glow: "from-indigo-500/30 via-purple-500/20 to-blue-500/30 dark:from-indigo-500/25 dark:via-purple-500/15 dark:to-blue-500/25",
        badge: "bg-indigo-100/60 text-indigo-700 border-indigo-200/80 dark:bg-indigo-500/20 dark:text-indigo-300 dark:border-indigo-500/30",
        badgeText: "Pro Plan",
        progressColor: "bg-gradient-to-r from-indigo-400 to-blue-500",
        iconColorClass: "text-indigo-600 dark:text-indigo-400",
      };
    }
    // Premium plan
    return {
      className:
        "border border-amber-200/60 dark:border-amber-900/40 hover:border-amber-300 dark:hover:border-amber-800 bg-gradient-to-br from-amber-100/90 via-orange-50/90 to-rose-100/90 dark:from-amber-500/20 dark:via-orange-500/10 dark:to-rose-500/20 shadow-sm transition-all duration-500 hover:shadow-md hover:scale-[1.01]",
      glow: "from-amber-500/30 via-orange-500/20 to-rose-500/30 dark:from-amber-500/25 dark:via-orange-500/15 dark:to-rose-500/25",
      badge: "bg-amber-100/60 text-amber-700 border-amber-200/80 dark:bg-amber-500/20 dark:text-amber-300 dark:border-amber-500/30",
      badgeText: "Premium Plan",
      progressColor: "bg-gradient-to-r from-amber-400 to-orange-500",
      iconColorClass: "text-amber-600 dark:text-amber-400",
    };
  }, [plan]);

  const handleOpenPlan = () => {
    window.dispatchEvent(
      new CustomEvent("tabslate-open-settings", {
        detail: { tab: "plan" },
      }),
    );
  };

  const renderQuotaRow = (
    label: string,
    Icon: React.ComponentType<any>,
    usageVal: number,
    limitVal: number,
  ) => {
    const isUnlimited = limitVal === -1;
    const percentage = isUnlimited
      ? 100
      : Math.min(100, (usageVal / limitVal) * 100);

    return (
      <div className="space-y-1.5 group/row">
        <div className="flex items-center justify-between text-[11px] font-medium leading-none">
          <span className="flex items-center gap-2 text-muted-foreground group-hover/row:text-foreground transition-colors duration-200">
            <Icon className={cn("size-3.5 shrink-0 transition-transform duration-300 group-hover/row:scale-110", cardStyles.iconColorClass)} />
            <span>{label}</span>
          </span>
          <span className="font-semibold text-foreground/80">
            {isUnlimited ? `${usageVal}/∞` : `${usageVal}/${limitVal}`}
          </span>
        </div>
        <div className="h-1.5 w-full bg-muted/40 rounded-full overflow-hidden relative">
          {isUnlimited ? (
            <div
              className={cn(
                "h-full rounded-full transition-all duration-1000 bg-gradient-to-r from-sky-400 via-violet-400 to-fuchsia-400 animate-pulse-subtle",
                plan === "premium" && "from-amber-400 via-orange-400 to-yellow-400",
              )}
              style={{ width: mounted ? "100%" : "0%" }}
            />
          ) : (
            <div
              className={cn(
                "h-full rounded-full transition-all duration-1000 ease-out",
                cardStyles.progressColor
              )}
              style={{ width: mounted ? `${percentage}%` : "0%" }}
            />
          )}
        </div>
      </div>
    );
  };

  const renderCompactStats = () => {
    const items = [
      { label: "Bookmarks", Icon: Bookmark, usageVal: usage.bookmarks, limitVal: limits.max_bookmarks },
      { label: "Collections", Icon: Folder, usageVal: usage.collections, limitVal: limits.max_collections },
      { label: "Tags", Icon: Tag, usageVal: usage.tags, limitVal: limits.max_tags },
      { label: "Workspaces", Icon: Monitor, usageVal: usage.workspaces, limitVal: limits.max_workspaces },
      { label: "Saved Groups", Icon: Sparkles, usageVal: usage.saved_groups, limitVal: limits.max_saved_groups },
    ];

    return (
      <div className="space-y-1 text-[11px] text-muted-foreground font-medium">
        {items.map(({ label, Icon, usageVal, limitVal }) => {
          const isUnlimited = limitVal === -1;
          const limitStr = isUnlimited ? "∞" : limitVal.toString();

          return (
            <div
              key={label}
              className="flex items-center justify-between py-0.5 px-1 rounded-md transition-colors"
            >
              <span className="flex items-center gap-2 text-muted-foreground/80">
                <Icon className={cn("size-3 shrink-0", cardStyles.iconColorClass)} />
                <span>{label}</span>
              </span>
              <span className="font-semibold text-foreground/80">
                {usageVal}<span className="text-muted-foreground/30 font-normal mx-0.5">/</span>{limitStr}
              </span>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={cn(
        "relative rounded-2xl border p-4 transition-all duration-500 text-left backdrop-blur-md group cursor-pointer",
        cardStyles.className,
        mounted ? "translate-y-0 opacity-100 scale-100" : "translate-y-4 opacity-0 scale-98"
      )}
      onClick={handleOpenPlan}
    >
      {/* Layer 1: Tight, bright glowing edge/ring */}
      <div
        className={cn(
          "absolute -inset-[1px] bg-gradient-to-r opacity-15 dark:opacity-10 group-hover:opacity-100 transition-all duration-500 blur-[3px] z-[-1] rounded-2xl pointer-events-none",
          cardStyles.glow
        )}
      />

      {/* Layer 2: Large, soft ambient aura/halo projecting on the sidebar */}
      <div
        className={cn(
          "absolute inset-0 bg-gradient-to-r opacity-20 dark:opacity-15 group-hover:opacity-80 transition-all duration-500 blur-xl z-[-2] rounded-2xl pointer-events-none",
          cardStyles.glow
        )}
      />

      {/* Inner Mask for clipping the background icon (mirroring homepage ad card) */}
      <div className="absolute inset-0 rounded-2xl overflow-hidden pointer-events-none z-0">
        {/* Layer 1: Soft color glow */}
        <div className="absolute -bottom-10 -right-10 opacity-25 dark:opacity-15 group-hover:opacity-45 transition-opacity duration-500">
          <AmbientIcon className={cn("w-48 h-48 blur-xl -rotate-12", iconColor)} />
        </div>
        {/* Layer 2: Crisp visible silhouette */}
        <div className="absolute -bottom-6 -right-6 opacity-[0.06] dark:opacity-[0.1] group-hover:opacity-[0.12] dark:group-hover:opacity-[0.18] transition-opacity duration-500">
          <AmbientIcon className={cn("w-40 h-40 -rotate-12", iconColor)} />
        </div>
      </div>

      <div className="relative z-10 flex flex-col gap-3">
        {/* Header with Title and Plan Badge */}
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-bold tracking-wider text-muted-foreground/80 uppercase">
            Capacity
          </span>
          <div
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border text-[9px] font-bold uppercase tracking-wider shadow-2xs",
              cardStyles.badge
            )}
          >
            <Award className="size-3 shrink-0" />
            <span>{cardStyles.badgeText}</span>
          </div>
        </div>

        {/* Collapsed State View: Compact Grid showing all 5 usages */}
        <div
          className={cn(
            "transition-all duration-500 ease-in-out",
            isHovered
              ? "max-h-0 opacity-0 overflow-hidden pointer-events-none"
              : "max-h-[140px] opacity-100"
          )}
        >
          {renderCompactStats()}
        </div>

        {/* Expanded State View: Detailed Quota Rows with progress bars + CTA */}
        <div
          className={cn(
            "overflow-hidden transition-all duration-500 ease-in-out",
            isHovered
              ? "max-h-[350px] opacity-100 mt-1"
              : "max-h-0 opacity-0 pointer-events-none"
          )}
        >
          <div className="pt-1 border-t border-muted/50 dark:border-zinc-800/40 space-y-3.5">
            <div className="mt-1" />
            {renderQuotaRow("Bookmarks", Bookmark, usage.bookmarks, limits.max_bookmarks)}
            {renderQuotaRow("Collections", Folder, usage.collections, limits.max_collections)}
            {renderQuotaRow("Tags", Tag, usage.tags, limits.max_tags)}
            {renderQuotaRow("Workspaces", Monitor, usage.workspaces, limits.max_workspaces)}
            {renderQuotaRow("Saved Groups", Sparkles, usage.saved_groups, limits.max_saved_groups)}

            {/* CTA Upgrade Banner */}
            {plan === "free" ? (
              <div className="mt-1 pt-3.5 border-t border-muted/50 dark:border-zinc-800/40 flex items-center justify-between text-[11px] font-semibold group/cta transition-colors">
                <span className="flex items-center gap-1.5">
                  <Zap className="size-3 text-amber-500 animate-bounce" style={{ animationDuration: '2s' }} />
                  <span className="bg-gradient-to-r from-blue-600 via-violet-600 to-fuchsia-600 dark:from-blue-400 dark:via-violet-400 dark:to-fuchsia-400 bg-clip-text text-transparent font-bold">
                    Upgrade to Pro for Unlimited
                  </span>
                </span>
                <ArrowUpRight className="size-3.5 text-violet-500 dark:text-violet-400 transition-transform duration-300 group-hover/cta:translate-x-0.5 group-hover/cta:-translate-y-0.5" />
              </div>
            ) : (
              <div className="mt-1 pt-3.5 border-t border-muted/50 dark:border-zinc-800/40 flex items-center justify-between text-[11px] text-muted-foreground font-medium group/cta hover:text-foreground transition-colors">
                <span>Manage Plan & Quotas</span>
                <ArrowUpRight className="size-3.5 transition-transform duration-300 group-hover/cta:translate-x-0.5 group-hover/cta:-translate-y-0.5" />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
