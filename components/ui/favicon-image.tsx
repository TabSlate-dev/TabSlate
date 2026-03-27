import * as React from "react";
import { Globe } from "lucide-react";
import { cn } from "@/lib/utils";

interface FaviconImageProps {
  src: string;
  alt?: string;
  /** Applied to both the <img> and the fallback Globe icon */
  className?: string;
  hasDarkIcon?: boolean;
}

/**
 * Renders a favicon <img> and falls back to a Globe icon when the src is
 * empty or fails to load.
 */
export function FaviconImage({ src, alt = "", className, hasDarkIcon }: FaviconImageProps) {
  const [failed, setFailed] = React.useState(false);

  // Reset error state when src changes
  React.useEffect(() => {
    setFailed(false);
  }, [src]);

  if (!src || failed) {
    return <Globe className={cn(className, "text-muted-foreground")} />;
  }

  return (
    <img
      src={src}
      alt={alt}
      className={cn(className, hasDarkIcon && "dark:invert")}
      onError={() => setFailed(true)}
    />
  );
}
