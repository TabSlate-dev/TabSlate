import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { usePlanStore, type QuotaResource } from "@/store/plan-store";
import { useTranslation } from "@/hooks/use-translation";
import type { PlanUsage } from "@/lib/api";

const USAGE_KEYS: Record<QuotaResource, keyof PlanUsage> = {
  bookmark: "bookmarks",
  collection: "collections",
  tag: "tags",
  workspace: "workspaces",
  saved_group: "saved_groups",
};

const LABEL_KEYS: Record<QuotaResource, string> = {
  bookmark: "quota_bookmarks",
  collection: "quota_collections",
  tag: "quota_tags",
  workspace: "quota_workspaces",
  saved_group: "quota_savedGroups",
};

export function QuotaAlert() {
  const { t } = useTranslation();
  const alert = usePlanStore((s) => s.quotaAlert);
  const usage = usePlanStore((s) => s.usage);
  const trashUsage = usePlanStore((s) => s.trashUsage);
  const inUseUsage = usePlanStore((s) => s.inUseUsage);
  if (!alert) { return null; }

  const usageKey = USAGE_KEYS[alert.resource];
  const substitutions = [
    t(LABEL_KEYS[alert.resource]),
    alert.limit.toString(),
    (usage?.[usageKey] ?? 0).toString(),
    (inUseUsage?.[usageKey] ?? 0).toString(),
    (trashUsage?.[usageKey] ?? 0).toString(),
  ];

  return (
    <Alert variant="info" className="fixed top-4 left-1/2 -translate-x-1/2 z-100 w-auto shadow-lg animate-in fade-in slide-in-from-top-2 pointer-events-none whitespace-nowrap">
      <AlertCircle className="h-4 w-4" />
      <AlertDescription>{t("quotaAlert_limitReached", substitutions)}</AlertDescription>
    </Alert>
  );
}
