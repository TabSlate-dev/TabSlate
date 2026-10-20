/** Run after `bun run build`: NODE_ENV=development bun scripts/check-bookmark-dialog-layout.ts [Chrome executable].
 * Captures real component DOM with generated CSS, then checks layout in headless Chrome.
 * This opt-in check needs Chrome; the ordinary Bun suite does not.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { createModuleReplacer, importFresh } from "../test/helpers/module-replacer";
import { getBySelector, installAppModules, render, setupDom, submitForm, teardownDom, typeInto } from "../test/helpers/dom-environment";
import { makeBookmark, makeCollection, makeTag, makeWorkspace } from "../test/helpers/library-fixtures";

const chrome = process.argv[2] ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const output = mkdtempSync(join(tmpdir(), "tabslate-dialog-layout-"));
setupDom();
const replacer = createModuleReplacer();
const app = await installAppModules(replacer);
const { BookmarkDialog } = await importFresh<typeof import("../components/dashboard/shared/bookmark-dialog")>("components/dashboard/shared/bookmark-dialog.tsx");
const { openBookmarkDialog } = await import("../lib/bookmark-dialog-events");
const tags = Array.from({ length: 45 }, (_, index) => makeTag(`tag-${index}`, `Reference topic ${index}`));
const bookmark = makeBookmark("long", {
  collectionId: "inbox",
  notes: Array.from({ length: 30 }, (_, index) => `Note line ${index}`).join("\n"),
  tags: tags.slice(0, 16).map((tag) => tag.id),
});
app.useWorkspaceStore.setState({ activeWorkspaceId: "home", workspaces: [makeWorkspace("home")], collections: [makeCollection("inbox", "home", { name: "Inbox", isDefault: true })], tags });
app.useBookmarksStore.setState({ bookmarks: new Map([[bookmark.id, bookmark]]), countsByCollection: { inbox: 1 }, selectedCollection: "all" });
const view = render(app, createElement(MemoryRouter, null, createElement(BookmarkDialog)));
try {
  act(() => openBookmarkDialog({ bookmarkId: bookmark.id }));
  typeInto(getBySelector<HTMLInputElement>('[name="title"]'), "");
  typeInto(getBySelector<HTMLInputElement>('[name="url"]'), "not a url");
  await submitForm(getBySelector<HTMLFormElement>("form"));
  act(() => getBySelector<HTMLInputElement>('[role="combobox"]').focus());
  const cssDir = resolve(".output/chrome-mv3/assets");
  const css = readdirSync(cssDir).filter((name) => name.endsWith(".css")).map((name) => readFileSync(join(cssDir, name), "utf8")).join("\n");
  const locale: Record<string, { message: string }> = JSON.parse(readFileSync("public/_locales/en/messages.json", "utf8"));
  let body = document.body.innerHTML;
  for (const [key, value] of Object.entries(locale)) {
    body = body.replaceAll(key, value.message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"));
  }
  const measurement = `
    const dialog = document.querySelector('[role="dialog"]');
    const rect = element => { const r = element.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,height:r.height}; };
    const title = dialog.querySelector('h2');
    const close = dialog.querySelector(':scope > button');
    const save = dialog.querySelector('button[type="submit"]');
    const cancel = save.previousElementSibling;
    const visible = element => {const r=rect(element), d=rect(dialog);return r.top>=Math.max(0,d.top) && r.bottom<=Math.min(innerHeight,d.bottom);};
    dialog.scrollTop=0;
    const start={title:visible(title),close:visible(close)};
    dialog.scrollTop=dialog.scrollHeight;
    const end={save:visible(save),cancel:visible(cancel),scrollTop:dialog.scrollTop};
    const result={viewport:innerHeight,dialog:rect(dialog),overflow:getComputedStyle(dialog).overflowY,start,end,options:dialog.querySelectorAll('[role="option"]').length,errors:dialog.querySelectorAll('[role="alert"]').length};
    result.pass=result.dialog.top>=0 && result.dialog.bottom<=innerHeight && start.title && start.close && end.save && end.cancel && end.scrollTop>0 && result.options>10 && result.errors===2;
    const pre=document.createElement('pre');pre.id='measurement';pre.textContent=JSON.stringify(result);document.body.append(pre);
  `;
  const fixture = join(output, "fixture.html");
  writeFileSync(fixture, `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style><style>*,*::before,*::after{animation:none!important;transition:none!important}</style></head><body>${body}<script>${measurement}</script></body></html>`);
  let failed = false;
  // Chrome's window frame differs by platform/version. Measure and adjust once.
  for (const height of [720, 480]) {
    let windowHeight = height;
    let result: { viewport: number; pass: boolean } | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const html = execFileSync(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", `--user-data-dir=${join(output, `profile-${height}`)}`, `--window-size=1280,${windowHeight}`, "--dump-dom", `file://${fixture}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      writeFileSync(join(output, `result-${height}.html`), html);
      const match = html.match(/<pre id="measurement">([^<]+)<\/pre>/);
      if (!match) { throw new Error("Chrome did not return layout measurements"); }
      result = JSON.parse(match[1]);
      if (!result) { throw new Error("Missing measurements"); }
      if (result.viewport === height) {
        console.log(match[1]);
        break;
      }
      windowHeight += height - result.viewport;
    }
    if (!result?.pass || result.viewport !== height) { failed = true; }
  }
  console.log(`Fixture and measured DOM: ${output}`);
  if (failed) { throw new Error("Bookmark dialog controls are not reachable within the requested viewports"); }
} finally {
  view.unmount();
  replacer.restore();
  await teardownDom();
}
