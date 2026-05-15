import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { usePlanStore, type QuotaResource } from "@/store/plan-store";

function quotaAlertMessage(resource: QuotaResource, limit: number): string {
  const messages: Record<QuotaResource, string> = {
    bookmark:    `已达书签上限（${limit} 条），请升级套餐以继续添加`,
    collection:  `已达集合上限（${limit} 个），请升级套餐以继续创建`,
    tag:         `已达标签上限（${limit} 个），请升级套餐以继续创建`,
    workspace:   `已达工作区上限（${limit} 个），请升级套餐以继续创建`,
    saved_group: `已达已保存分组上限（${limit} 个），请升级套餐以继续创建`,
  };
  return messages[resource];
}

export function QuotaAlert() {
  const alert = usePlanStore((s) => s.quotaAlert);
  if (!alert) { return null; }

  return (
    <Alert variant="info" className="fixed top-4 left-1/2 -translate-x-1/2 z-100 w-auto shadow-lg animate-in fade-in slide-in-from-top-2 pointer-events-none whitespace-nowrap">
      <AlertCircle className="h-4 w-4" />
      <AlertDescription>{quotaAlertMessage(alert.resource, alert.limit)}</AlertDescription>
    </Alert>
  );
}
