import { RefreshCw, ShieldCheck, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { SyncStatus } from "@/lib/sync-engine";
import { requestAccountDataConsent } from "@/lib/browser/data-collection";
import { useTranslation } from "@/hooks/use-translation";
import { useAccountDataConsent } from "@/hooks/use-account-data-consent";

interface SyncStatusProps {
  status: SyncStatus;
  errorMessage?: string | null;
  onForceSync: () => void;
  isGuest: boolean;
  onRegister: () => void;
}

export function SyncStatusIndicator({
  status,
  errorMessage,
  onForceSync,
  isGuest,
  onRegister,
}: SyncStatusProps) {
  const { t } = useTranslation();
  const accountDataConsent = useAccountDataConsent();

  const handleAllowSync = () => {
    // Firefox only shows its consent prompt while handling the click, so the
    // request has to start here, before anything async.
    void requestAccountDataConsent().then((granted) => {
      if (granted) {
        onForceSync();
      }
    });
  };

  if (isGuest) {
    return (
      <div className="flex items-center gap-3 px-2 py-1">
        <div
          className="flex items-center gap-1.5 text-xs text-muted-foreground w-24 shrink-0"
          aria-label={t("sync_signedOut")}
        >
          <span className="w-2 h-2 rounded-full shrink-0 bg-muted-foreground/50" aria-hidden="true" />
          <span className="truncate">{t("sync_signedOut")}</span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRegister}
          aria-label={t("sync_registerNow")}
          className="h-6 px-2 text-xs"
        >
          <UserPlus className="size-3" />
          {t("sync_registerNow")}
        </Button>
      </div>
    );
  }

  // Signed in on Firefox, but the account data collection hasn't been allowed
  // (session from before this was required, or revoked in about:addons).
  if (accountDataConsent === false) {
    return (
      <TooltipProvider>
        <div className="flex items-center gap-3 px-2 py-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className="flex items-center gap-1.5 text-xs text-muted-foreground w-24 shrink-0"
                aria-label={`${t("sync_paused")}: ${t("sync_pausedDesc")}`}
              >
                <span className="w-2 h-2 rounded-full shrink-0 bg-yellow-500" aria-hidden="true" />
                <span className="truncate">{t("sync_paused")}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs wrap-break-word">
              {t("sync_pausedDesc")}
            </TooltipContent>
          </Tooltip>
          <Button
            variant="outline"
            size="sm"
            onClick={handleAllowSync}
            className="h-6 px-2 text-xs"
          >
            <ShieldCheck className="size-3" />
            {t("sync_allowSync")}
          </Button>
        </div>
      </TooltipProvider>
    );
  }

  const dot: Record<SyncStatus, string> = {
    idle:    "bg-green-500",
    syncing: "bg-blue-500 animate-pulse",
    error:   "bg-yellow-500",
    offline: "bg-red-500",
  };

  const label: Record<SyncStatus, string> = {
    idle:    t("sync_idle"),
    syncing: t("sync_syncing"),
    error:   t("sync_error"),
    offline: t("sync_offline"),
  };

  const statusLabel = (
    <div
      className="flex items-center gap-1.5 text-xs text-muted-foreground w-24 shrink-0"
      aria-label={`Sync status: ${label[status]}`}
    >
      <span className={`w-2 h-2 rounded-full shrink-0 ${dot[status]}`} aria-hidden="true" />
      <span className="truncate">{label[status]}</span>
    </div>
  );

  return (
    <TooltipProvider>
      <div className="flex items-center gap-3 px-2 py-1">
        {status === "error" && errorMessage ? (
          <Tooltip>
            <TooltipTrigger asChild>
              {statusLabel}
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs wrap-break-word">
              {errorMessage}
            </TooltipContent>
          </Tooltip>
        ) : statusLabel}
        <Button
          variant="outline"
          size="sm"
          onClick={onForceSync}
          disabled={status === "syncing"}
          aria-label={t("sync_syncNow")}
          className="h-6 px-2 text-xs"
        >
          <RefreshCw className={`size-3 ${status === "syncing" ? "animate-spin" : ""}`} />
          {t("sync_syncNow")}
        </Button>
      </div>
    </TooltipProvider>
  );
}
