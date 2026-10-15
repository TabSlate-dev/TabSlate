/**
 * Query parameter of the newtab link that reveals one bookmark:
 * `newtab.html#/?highlight=<bookmarkId>`. Kept free of store imports because
 * the popup builds these links and must not load Zustand.
 */
export const HIGHLIGHT_PARAM = "highlight";
