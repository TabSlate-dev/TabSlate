import * as React from "react";
import { LogOut, ShieldCheck, ChevronRight } from "lucide-react";
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

  return (
    <div className="px-3 py-4">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="w-full group outline-none">
            <div
              className={cn(
                "relative overflow-hidden rounded-2xl border border-muted/60 bg-gradient-to-br from-background/50 via-background/80 to-muted/20 p-3.5 transition-all duration-500",
                "hover:border-primary/40 hover:shadow-xl hover:shadow-primary/5 text-left backdrop-blur-md",
              )}
            >
              <div className="absolute -right-4 -top-4 size-24 rounded-full bg-primary/10 blur-2xl transition-all duration-700 group-hover:bg-primary/20 group-hover:scale-125" />
              <div className="absolute -left-4 -bottom-4 size-16 rounded-full bg-blue-500/5 blur-xl transition-all duration-700 group-hover:bg-blue-500/10 group-hover:scale-110" />

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
                  {renewsLabel && (
                    <span className="text-[11px] text-muted-foreground/70 truncate mt-0.5 leading-none">
                      {renewsLabel}
                    </span>
                  )}
                </div>

                <ChevronRight className="size-4 text-muted-foreground/30 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground/60" />
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
