import { Copy } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/hooks/use-translation";
import type { DuplicateMatch } from "@/lib/duplicate-lookup";

interface DuplicateNoticeProps {
  matches: readonly DuplicateMatch[];
  onOpenExisting: (bookmarkId: string) => void;
  className?: string;
}

/** Saving stays possible; this only says where the address is already saved. */
export function DuplicateNotice({ matches, onOpenExisting, className }: DuplicateNoticeProps) {
  const { t } = useTranslation();
  const first = matches[0];
  if (!first) {
    return null;
  }
  const location = first.collection && first.workspace
    ? t("duplicateNotice_location", [first.collection.name, first.workspace.name])
    : t("duplicateNotice_uncategorized");

  return (
    <Alert data-slot="duplicate-notice" role="status" className={cn("py-2", className)}>
      <Copy />
      <AlertDescription className="flex flex-wrap items-center gap-x-2">
        <span>{t("duplicateNotice_alreadySaved", [location])}</span>
        {matches.length > 1 && <span>{t("duplicateNotice_more", [String(matches.length - 1)])}</span>}
        <Button type="button" variant="link" size="xs" className="px-0" onClick={() => onOpenExisting(first.bookmark.id)}>
          {t("duplicateNotice_openExisting")}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
