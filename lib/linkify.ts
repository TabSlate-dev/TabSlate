export interface LinkifySegment {
  kind: "text" | "link";
  text: string;
}

const LINK_PATTERN = /https?:\/\/[^\s<>"']+/gi;
/** Punctuation that ends a sentence right after a link stays outside the link. */
const TRAILING_PUNCTUATION = /[.,;:!?)]+$/;
const WEB_LINK = /^https?:\/\/./i;

/**
 * Splits note text into plain text and http(s) links. Callers render the
 * segments as React text and elements, never as HTML.
 */
export function linkifySegments(text: string): LinkifySegment[] {
  const segments: LinkifySegment[] = [];
  let textStart = 0;
  for (const match of text.matchAll(LINK_PATTERN)) {
    const start = match.index ?? 0;
    const link = match[0].replace(TRAILING_PUNCTUATION, "");
    if (!WEB_LINK.test(link)) {
      continue;
    }
    if (start > textStart) {
      segments.push({ kind: "text", text: text.slice(textStart, start) });
    }
    segments.push({ kind: "link", text: link });
    textStart = start + link.length;
  }
  if (textStart < text.length) {
    segments.push({ kind: "text", text: text.slice(textStart) });
  }
  return segments;
}
