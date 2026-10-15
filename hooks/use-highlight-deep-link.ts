import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { revealBookmark } from "@/lib/reveal-bookmark";
import { HIGHLIGHT_PARAM } from "@/lib/highlight-link";

/** Reveals the bookmark named by `#/?highlight=<id>` once, then removes the parameter. */
export function useHighlightDeepLink(): void {
  const [searchParams, setSearchParams] = useSearchParams();
  const bookmarkId = searchParams.get(HIGHLIGHT_PARAM);

  useEffect(() => {
    if (bookmarkId === null) {
      return;
    }
    revealBookmark(bookmarkId);
    setSearchParams(
      (params) => {
        params.delete(HIGHLIGHT_PARAM);
        return params;
      },
      { replace: true },
    );
  }, [bookmarkId, setSearchParams]);
}
