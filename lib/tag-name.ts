export const MAX_TAG_NAME_LENGTH = 50;

export type TagNameError = "empty" | "duplicate" | "slash" | "too_long";

/** Identity is independent of the locale used to sort labels for display. */
export function normalizeTagName(name: string): string {
  return name.trim().toLowerCase();
}

/** A tag needs a name, and no other tag may have it, ignoring case and surrounding spaces. */
export function tagNameError(name: string, takenNames: readonly string[]): TagNameError | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return "empty";
  }
  if (trimmed.includes("/")) {
    return "slash";
  }
  if (Array.from(trimmed).length > MAX_TAG_NAME_LENGTH) {
    return "too_long";
  }
  return takenNames.some((taken) => normalizeTagName(taken) === normalizeTagName(trimmed)) ? "duplicate" : null;
}
