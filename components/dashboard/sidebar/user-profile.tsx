import * as React from "react";
import {
  LogOut,
  ShieldCheck,
  ChevronRight,
  Award,
  Bookmark,
  Folder,
  Tag,
  Monitor,
  Sparkles,
} from "lucide-react";
import { useAuthStore } from "@/store/auth-store";
import { usePlanStore } from "@/store/plan-store";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

function formatRenewsDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function UserProfile() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const subscription = usePlanStore((s) => s.subscription);
  const limits = usePlanStore((s) => s.limits);
  const usage = usePlanStore((s) => s.usage);

  if (!user) return null;

  const initials = user.name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase();

  const renewsLabel =
    subscription &&
    subscription.plan !== "free" &&
    subscription.status === "ACTIVE" &&
    subscription.expires_at != null
      ? `Renews ${formatRenewsDate(subscription.expires_at)}`
      : null;

  const cardStyles = React.useMemo(() => {
    const plan = subscription?.plan ?? "free";
    if (plan === "free") {
      return {
        className:
          "border-muted-foreground/20 bg-card shadow-md shadow-black/5 hover:border-primary/45 hover:shadow-lg hover:shadow-primary/5",
        glow1: "bg-primary/10 group-hover:bg-primary/20",
        glow2: "bg-blue-500/5 group-hover:bg-blue-500/10",
        badgeColor: "text-slate-500 dark:text-zinc-400",
        bannerClass:
          "bg-slate-500/5 dark:bg-zinc-800/40 border-slate-500/10 dark:border-zinc-700/30",
        bannerText: "text-slate-500 dark:text-zinc-400",
        labelText: "Free Plan",
      };
    }
    if (plan === "pro") {
      return {
        className:
          "border-violet-500/35 bg-gradient-to-br from-violet-500/[0.04] via-card to-violet-500/[0.09] shadow-md shadow-violet-500/5 hover:border-violet-500/50 hover:shadow-lg hover:shadow-violet-500/10",
        glow1: "bg-violet-500/15 group-hover:bg-violet-500/25",
        glow2: "bg-fuchsia-500/5 group-hover:bg-fuchsia-500/10",
        badgeColor: "text-violet-500",
        bannerClass:
          "bg-violet-500/10 dark:bg-violet-950/30 border-violet-500/20",
        bannerText: "text-violet-600 dark:text-violet-300 font-bold",
        labelText: "Pro Member",
      };
    }
    // Premium plan
    return {
      className:
        "border-amber-500/35 bg-gradient-to-br from-amber-500/[0.04] via-card to-amber-500/[0.09] shadow-md shadow-amber-500/5 hover:border-amber-500/50 hover:shadow-lg hover:shadow-amber-500/10",
      glow1: "bg-amber-500/15 group-hover:bg-amber-500/25",
      glow2: "bg-orange-500/5 group-hover:bg-orange-500/10",
      badgeColor: "text-amber-500",
      bannerClass: "bg-amber-500/10 dark:bg-amber-950/30 border-amber-500/20",
      bannerText: "text-amber-600 dark:text-amber-350 font-bold",
      labelText: "Premium Plan",
    };
  }, [subscription]);

  const renderResourceQuota = (
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
      <div className="space-y-1">
        <div className="flex items-center justify-between text-[10px] text-muted-foreground leading-none font-medium">
          <span className="flex items-center gap-1.5">
            <Icon className="size-3 text-muted-foreground/60 shrink-0" />
            <span className="truncate">{label}</span>
          </span>
          <span className="text-[10px] font-semibold text-foreground/80 shrink-0 ml-1">
            {isUnlimited ? `${usageVal}/∞` : `${usageVal}/${limitVal}`}
          </span>
        </div>
        <div className="h-0.5 w-full bg-muted/40 rounded-full overflow-hidden">
          {isUnlimited ? (
            <div
              className={cn(
                "h-full rounded-full animate-pulse bg-gradient-to-r from-sky-400/80 via-violet-400/80 to-fuchsia-400/80",
                subscription?.plan === "premium" &&
                  "from-amber-400/80 via-orange-400/80 to-yellow-400/80",
              )}
              style={{ width: "100%" }}
            />
          ) : (
            <div
              className={cn(
                "h-full rounded-full transition-all duration-500",
                subscription?.plan === "pro"
                  ? "bg-gradient-to-r from-violet-500/80 to-fuchsia-500/80"
                  : subscription?.plan === "premium"
                    ? "bg-gradient-to-r from-amber-500/80 to-orange-500/80"
                    : "bg-primary/80",
              )}
              style={{ width: `${percentage}%` }}
            />
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="px-3 py-4">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="w-full group outline-none">
            <div
              className={cn(
                "relative overflow-hidden rounded-2xl border p-3.5 transition-all duration-500 text-left backdrop-blur-md",
                cardStyles.className,
              )}
            >
              {/* Animated background glow */}
              <div
                className={cn(
                  "absolute -right-4 -top-4 size-24 rounded-full blur-2xl transition-all duration-700 group-hover:scale-125",
                  cardStyles.glow1,
                )}
              />
              <div
                className={cn(
                  "absolute -left-4 -bottom-4 size-16 rounded-full blur-xl transition-all duration-700 group-hover:scale-110",
                  cardStyles.glow2,
                )}
              />

              <div className="relative flex flex-col">
                <div className="relative flex items-center gap-3">
                  <Avatar className="size-10 border-2 border-background shadow-sm transition-transform group-hover:scale-105">
                    <AvatarImage src="" />
                    <AvatarFallback className="bg-primary/10 text-primary font-bold text-xs">
                      {initials}
                    </AvatarFallback>
                  </Avatar>

                  <div className="flex flex-1 flex-col truncate">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-semibold truncate leading-none">
                        {user.name}
                      </span>
                      {user.is_verified && (
                        <ShieldCheck className="size-3.5 text-blue-500 fill-blue-500/10 shrink-0" />
                      )}
                    </div>
                    <span className="text-[11px] text-muted-foreground truncate mt-1 leading-none">
                      {user.email}
                    </span>
                  </div>

                  <ChevronRight className="size-4 text-muted-foreground/30 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground/60" />
                </div>

                {/* Explicit Premium Plan Status Pill */}
                <div
                  className={cn(
                    "relative flex items-center gap-2 mt-3 px-2.5 py-1.5 rounded-xl border select-none transition-all duration-300",
                    cardStyles.bannerClass,
                  )}
                >
                  <Award
                    className={cn("size-3.5 shrink-0", cardStyles.badgeColor)}
                  />
                  <span
                    className={cn(
                      "text-[9px] uppercase tracking-wider font-extrabold leading-none",
                      cardStyles.bannerText,
                    )}
                  >
                    {cardStyles.labelText}
                  </span>
                  {renewsLabel && (
                    <span className="text-[8px] text-muted-foreground/60 ml-auto font-medium leading-none">
                      {renewsLabel}
                    </span>
                  )}
                </div>

                {/* Sleek, full resource quotas layout */}
                {limits && usage && (
                  <div className="relative mt-3.5 pt-3 border-t border-muted/50 space-y-2.5">
                    {renderResourceQuota(
                      "Bookmarks",
                      Bookmark,
                      usage.bookmarks,
                      limits.max_bookmarks,
                    )}
                    {renderResourceQuota(
                      "Collections",
                      Folder,
                      usage.collections,
                      limits.max_collections,
                    )}
                    {renderResourceQuota(
                      "Tags",
                      Tag,
                      usage.tags,
                      limits.max_tags,
                    )}
                    {renderResourceQuota(
                      "Workspaces",
                      Monitor,
                      usage.workspaces,
                      limits.max_workspaces,
                    )}
                    {renderResourceQuota(
                      "Saved Groups",
                      Sparkles,
                      usage.saved_groups,
                      limits.max_saved_groups,
                    )}
                  </div>
                )}
              </div>
            </div>
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          className="w-56"
          align="start"
          side="right"
          sideOffset={10}
        >
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col space-y-1">
              <p className="text-sm font-medium leading-none">{user.name}</p>
              <p className="text-xs leading-none text-muted-foreground">
                {user.email}
              </p>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />

          <DropdownMenuItem
            className="cursor-pointer flex items-center gap-2"
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent("tabslate-open-settings", {
                  detail: { tab: "plan" },
                }),
              );
            }}
          >
            <Award className={cn("size-4", cardStyles.badgeColor)} />
            <span>Plan & Quotas</span>
          </DropdownMenuItem>

          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="cursor-pointer text-destructive focus:text-destructive"
            onClick={() => logout()}
          >
            <LogOut className="mr-2 size-4" />
            <span>Log out</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
