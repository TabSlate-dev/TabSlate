export type TagNameError = "empty" | "duplicate";

/** A tag needs a name, and no other tag may have it, ignoring case and surrounding spaces. */
export function tagNameError(name: string, takenNames: readonly string[]): TagNameError | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return "empty";
  }
  const lower = trimmed.toLowerCase();
  return takenNames.some((taken) => taken.trim().toLowerCase() === lower) ? "duplicate" : null;
}
