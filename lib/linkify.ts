export interface LinkifySegment {
  kind: "text" | "link";
  text: string;
}

/**
 * A link stops at whitespace, quotes, and the punctuation of prose written
 * without spaces around URLs: general punctuation (curly quotes, ellipses,
 * dashes), CJK punctuation (，。、《》) and full-width forms (（）！？).
 * CJK ideographs stay, since paths can contain them.
 */
const LINK_PATTERN = /https?:\/\/[^\s<>"'\u2000-\u206F\u3000-\u303F\uFF00-\uFFEF]+/gi;
/** Punctuation that ends a sentence right after a link stays outside the link. */
const SENTENCE_PUNCTUATION = /[.,;:!?]/;
const WEB_LINK = /^https?:\/\/./i;

/** Keeps closing parentheses that match an opening one inside the URL. */
function trimTrailingPunctuation(link: string): string {
  let linkEnd = 0;
  let openParentheses = 0;
  for (let index = 0; index < link.length; index += 1) {
    const character = link.charAt(index);
    if (character === "(") {
      openParentheses += 1;
    } else if (character === ")") {
      if (openParentheses === 0) {
        continue;
      }
      openParentheses -= 1;
    }
    // Only the suffix after the last URL character is removed. Punctuation
    // earlier in the path/query stays, including unmatched internal ")".
    if (!SENTENCE_PUNCTUATION.test(character)) {
      linkEnd = index + 1;
    }
  }
  return link.slice(0, linkEnd);
}

/**
 * Splits note text into plain text and http(s) links. Callers render the
 * segments as React text and elements, never as HTML.
 */
export function linkifySegments(text: string): LinkifySegment[] {
  const segments: LinkifySegment[] = [];
  let textStart = 0;
  for (const match of text.matchAll(LINK_PATTERN)) {
    const start = match.index ?? 0;
    const link = trimTrailingPunctuation(match[0]);
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
