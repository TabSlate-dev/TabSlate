import { CheckCircle2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useTranslation } from "@/hooks/use-translation";

interface SyncRecoveryAlertProps {
  targetWorkspaceName: string | null;
}

export function SyncRecoveryAlert({ targetWorkspaceName }: SyncRecoveryAlertProps) {
  const { t } = useTranslation();

  if (!targetWorkspaceName) {
    return null;
  }

  return (
    <Alert className="fixed top-4 left-1/2 -translate-x-1/2 z-100 w-auto shadow-lg animate-in fade-in slide-in-from-top-2 pointer-events-none whitespace-nowrap">
      <CheckCircle2 className="h-4 w-4" />
      <AlertDescription>{t("sync_guestDataMerged", [targetWorkspaceName])}</AlertDescription>
    </Alert>
  );
}
