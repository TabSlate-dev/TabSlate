import * as React from "react";
import { FaviconImage } from "@/components/ui/favicon-image";
import { cn } from "@/lib/utils";

/** Covers that failed to load this page session; cards that mount again do not retry them. */
const failedCoverUrls = new Set<string>();

/** Soft placeholder backgrounds, picked by host so a site keeps its color. */
const COVER_PLACEHOLDER_TONES = [
  "bg-sky-100 dark:bg-sky-950/60",
  "bg-emerald-100 dark:bg-emerald-950/60",
  "bg-amber-100 dark:bg-amber-950/60",
  "bg-rose-100 dark:bg-rose-950/60",
  "bg-violet-100 dark:bg-violet-950/60",
  "bg-teal-100 dark:bg-teal-950/60",
  "bg-orange-100 dark:bg-orange-950/60",
  "bg-indigo-100 dark:bg-indigo-950/60",
];

/** The host of a bookmark's address without "www.", or "" when the address does not parse. */
export function coverHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** A stable placeholder tone for a host (FNV-1a hash). */
export function coverToneIndex(host: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < host.length; index += 1) {
    hash ^= host.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % COVER_PLACEHOLDER_TONES.length;
}

interface BookmarkCoverPlaceholderProps {
  url: string;
  favicon: string;
  hasDarkIcon?: boolean;
}

/** The site's icon and host on a tone of its own; the card's title names the bookmark. */
export function BookmarkCoverPlaceholder({ url, favicon, hasDarkIcon }: BookmarkCoverPlaceholderProps) {
  const host = coverHost(url);
  return (
    <div
      aria-hidden="true"
      data-cover-placeholder=""
      className={cn(
        "flex size-full flex-col items-center justify-center gap-2 text-muted-foreground",
        COVER_PLACEHOLDER_TONES[coverToneIndex(host)],
      )}
    >
      <FaviconImage src={favicon} className="size-8" hasDarkIcon={hasDarkIcon} />
      {host && <span className="max-w-[80%] truncate text-xs font-medium">{host}</span>}
    </div>
  );
}

interface BookmarkCoverProps {
  imageUrl?: string;
  url: string;
  favicon: string;
  hasDarkIcon?: boolean;
}

/** A large card's cover: the page's image at the og:image ratio, else the placeholder. */
export const BookmarkCover = React.memo(function BookmarkCover({ imageUrl, url, favicon, hasDarkIcon }: BookmarkCoverProps) {
  const [failedUrl, setFailedUrl] = React.useState("");
  const cover = imageUrl && imageUrl !== failedUrl && !failedCoverUrls.has(imageUrl) ? imageUrl : "";

  const handleError = React.useCallback(() => {
    if (!imageUrl) {
      return;
    }
    failedCoverUrls.add(imageUrl);
    setFailedUrl(imageUrl);
  }, [imageUrl]);

  return (
    <div className="aspect-[1.91/1] w-full overflow-hidden rounded-t-xl bg-muted">
      {cover ? (
        <img
          src={cover}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          className="size-full object-cover"
          onError={handleError}
        />
      ) : (
        <BookmarkCoverPlaceholder url={url} favicon={favicon} hasDarkIcon={hasDarkIcon} />
      )}
    </div>
  );
});
