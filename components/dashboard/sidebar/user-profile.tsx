import * as React from "react";
import {
  LogOut,
  ShieldCheck,
  ChevronRight,
  Award,
  Upload,
  Sparkles,
  Zap,
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

export function UserProfile() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const subscription = usePlanStore((s) => s.subscription);

  if (!user) return null;

  const initials = user.name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase();

  const plan = subscription?.plan ?? "free";

  const glowStyles = React.useMemo(() => {
    if (plan === "free") {
      return {
        bg: "bg-gradient-to-br from-slate-100/90 via-slate-50/90 to-slate-200/90 dark:from-zinc-800/90 dark:via-zinc-900/90 dark:to-black/90",
        glow: "from-slate-400/30 via-slate-300/20 to-zinc-400/20 dark:from-slate-500/20 dark:via-slate-500/10 dark:to-zinc-500/10",
        border: "border-slate-200 dark:border-zinc-800/80",
        borderHover: "hover:border-slate-300 dark:hover:border-zinc-700",
        iconColorClass: "text-slate-500 dark:text-zinc-400",
        fallbackBg: "bg-slate-200/50 text-slate-600 dark:bg-zinc-800 dark:text-zinc-300",
      };
    }
    if (plan === "pro") {
      return {
        bg: "bg-gradient-to-br from-indigo-100/90 via-purple-50/90 to-blue-100/90 dark:from-indigo-500/20 dark:via-purple-500/10 dark:to-blue-500/20",
        glow: "from-indigo-500/30 via-purple-500/20 to-blue-500/30 dark:from-indigo-500/25 dark:via-purple-500/15 dark:to-blue-500/25",
        border: "border-indigo-200/60 dark:border-indigo-900/40",
        borderHover: "hover:border-indigo-300 dark:hover:border-indigo-800",
        iconColorClass: "text-indigo-600 dark:text-indigo-400",
        fallbackBg: "bg-indigo-100/60 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300",
      };
    }
    // Premium plan
    return {
      bg: "bg-gradient-to-br from-amber-100/90 via-orange-50/90 to-rose-100/90 dark:from-amber-500/20 dark:via-orange-500/10 dark:to-rose-500/20",
      glow: "from-amber-500/30 via-orange-500/20 to-rose-500/30 dark:from-amber-500/25 dark:via-orange-500/15 dark:to-rose-500/25",
      border: "border-amber-200/60 dark:border-amber-900/40",
      borderHover: "hover:border-amber-300 dark:hover:border-amber-800",
      iconColorClass: "text-amber-600 dark:text-amber-400",
      fallbackBg: "bg-amber-100/60 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
    };
  }, [plan]);

  const AmbientIcon = plan === "free" ? Award : plan === "pro" ? Zap : Sparkles;

  return (
    <div className="px-3 py-4">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="w-full group outline-none cursor-pointer relative block">
            {/* Layer 1: Tight contour glow */}
            <div
              className={cn(
                "absolute -inset-[1px] bg-gradient-to-r opacity-15 dark:opacity-10 group-hover:opacity-100 transition-all duration-500 blur-[3px] z-0 rounded-xl pointer-events-none",
                glowStyles.glow
              )}
            />

            {/* Layer 2: Soft ambient aura */}
            <div
              className={cn(
                "absolute inset-0 bg-gradient-to-r opacity-20 dark:opacity-15 group-hover:opacity-80 transition-all duration-500 blur-xl z-0 rounded-xl pointer-events-none",
                glowStyles.glow
              )}
            />

            {/* Watermark silhouette mask */}
            <div className="absolute inset-0 rounded-xl overflow-hidden pointer-events-none z-0">
              <div className="absolute -bottom-6 -right-6 opacity-[0.05] dark:opacity-[0.08] group-hover:opacity-[0.09] dark:group-hover:opacity-[0.14] transition-opacity duration-500">
                <AmbientIcon className={cn("w-20 h-20 -rotate-12", glowStyles.iconColorClass)} />
              </div>
            </div>

            <div
              className={cn(
                "relative z-10 flex items-center gap-3 p-2.5 rounded-xl border backdrop-blur-md shadow-sm transition-all duration-500 hover:shadow-md hover:scale-[1.01] text-left",
                glowStyles.bg,
                glowStyles.border,
                glowStyles.borderHover
              )}
            >
              <Avatar className="size-8.5 border border-muted/50 shadow-2xs transition-all duration-300 group-hover:scale-105 group-hover:border-primary/30">
                <AvatarImage src="" />
                <AvatarFallback className={cn("font-bold text-xs transition-colors duration-300", glowStyles.fallbackBg)}>
                  {initials}
                </AvatarFallback>
              </Avatar>

              <div className="flex flex-1 flex-col truncate">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-semibold truncate leading-none">
                    {user.name}
                  </span>
                  {user.is_verified && (
                    <ShieldCheck className="size-3.5 text-primary/80 dark:text-primary/90 shrink-0" />
                  )}
                </div>
                <span className="text-[11px] text-muted-foreground truncate mt-1 leading-none">
                  {user.email}
                </span>
              </div>

              <ChevronRight className="size-4 text-muted-foreground/30 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground/60" />
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
            <Award className={cn("size-4", glowStyles.iconColorClass)} />
            <span>Plan & Quotas</span>
          </DropdownMenuItem>

          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="cursor-pointer flex items-center gap-2"
            onClick={() => {
              window.dispatchEvent(new CustomEvent("tabslate-open-import"));
            }}
          >
            <Upload className="size-4" />
            <span>Import Bookmarks</span>
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
