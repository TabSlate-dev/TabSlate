import * as React from "react";
import { Link } from "react-router-dom";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

export interface BulkNoticeContent {
  message: string;
  tone: "success" | "error";
  /** A page that shows the result, e.g. the Archive. */
  link?: { label: string; to: string };
}

const NOTICE_DURATION_MS = 3000;

/** The current notice, and a function that shows a new one for three seconds. */
export function useBulkNotice(): [BulkNoticeContent | null, (notice: BulkNoticeContent) => void] {
  const [notice, setNotice] = React.useState<BulkNoticeContent | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
  }, []);

  const showNotice = React.useCallback((next: BulkNoticeContent) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    setNotice(next);
    timerRef.current = setTimeout(() => {
      setNotice(null);
      timerRef.current = null;
    }, NOTICE_DURATION_MS);
  }, []);

  return [notice, showNotice];
}

interface BulkNoticeProps {
  notice: BulkNoticeContent;
}

/** The floating notice from CLAUDE.md; it takes pointer events only when it has a link. */
export function BulkNotice({ notice }: BulkNoticeProps) {
  const Icon = notice.tone === "error" ? AlertCircle : CheckCircle2;
  return (
    <Alert
      role="status"
      variant={notice.tone === "error" ? "destructive" : "default"}
      className={cn(
        "fixed top-4 left-1/2 -translate-x-1/2 z-100 w-auto shadow-lg animate-in fade-in slide-in-from-top-2 whitespace-nowrap",
        notice.link ? "pointer-events-auto" : "pointer-events-none",
      )}
    >
      <Icon />
      <AlertDescription className="flex items-center gap-2">
        <span>{notice.message}</span>
        {notice.link && (
          <Link to={notice.link.to} className="font-medium text-foreground underline underline-offset-4">
            {notice.link.label}
          </Link>
        )}
      </AlertDescription>
    </Alert>
  );
}
