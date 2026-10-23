// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildChromeImportPlan, parseChromeHTML } from "@/lib/import-chrome";
import type { ImportTagOptions } from "@/lib/import-types";
import { buildTagTree, displayTagPath } from "@/lib/tag-tree";
import type { Tag } from "@/lib/types";
import { setupDom, teardownDom } from "./helpers/dom-environment";

beforeAll(() => {
  setupDom();
});

afterAll(async () => {
  await teardownDom();
});

const SAMPLE_CHROME_HTML = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
  <DT><H3 ADD_DATE="1700000000" LAST_MODIFIED="1700000000" PERSONAL_TOOLBAR_FOLDER="true">书签栏</H3>
  <DL><p>
    <DT><A HREF="https://root.example.com">Direct Root Bookmark</A>
    <DT><H3>开发</H3>
    <DL><p>
      <DT><A HREF="https://dev.example.com">Direct Dev Bookmark</A>
      <DT><H3>前端</H3>
      <DL><p>
        <DT><H3>React</H3>
        <DL><p>
          <DT><A HREF="https://react.dev">React Documentation</A>
        </DL><p>
      </DL><p>
    </DL><p>
    <DT><H3>开发</H3>
    <DL><p>
      <DT><A HREF="https://dev2.example.com">Dev 2 Bookmark</A>
    </DL><p>
    <DT><H3>Empty Folder</H3>
    <DL><p>
    </DL><p>
  </DL><p>
  <DT><H3>Mobile Bookmarks</H3>
  <DL><p>
    <DT><A HREF="https://mobile.example.com">Mobile Bookmark</A>
  </DL><p>
</DL><p>`;

describe("parseChromeHTML & buildChromeImportPlan", () => {
  test("parseChromeHTML extracts folderPath relative to allocated collection", () => {
    const collections = parseChromeHTML(SAMPLE_CHROME_HTML);

    const rootCol = collections.find(c => c.name === "书签栏");
    expect(rootCol).toBeDefined();
    expect(rootCol?.items).toEqual([
      { title: "Direct Root Bookmark", url: "https://root.example.com", folderPath: [] },
    ]);

    const devCol = collections.find(c => c.name === "开发");
    expect(devCol).toBeDefined();
    expect(devCol?.items).toContainEqual({
      title: "Direct Dev Bookmark",
      url: "https://dev.example.com",
      folderPath: [],
    });
    expect(devCol?.items).toContainEqual({
      title: "React Documentation",
      url: "https://react.dev",
      folderPath: ["前端", "React"],
    });

    const dev2Col = collections.find(c => c.name === "开发 (2)");
    expect(dev2Col).toBeDefined();
    expect(dev2Col?.items).toEqual([
      { title: "Dev 2 Bookmark", url: "https://dev2.example.com", folderPath: [] },
    ]);

    // Mobile bookmarks are skipped
    expect(collections.some(c => c.name.toLowerCase().includes("mobile"))).toBe(false);
  });

  test("hierarchy plan produces tag path: Chrome import 2026-10-21 › 开发 › 前端 › React", () => {
    const collections = parseChromeHTML(SAMPLE_CHROME_HTML);
    const tagOptions: ImportTagOptions = {
      enabled: true,
      rootName: "Chrome import 2026-10-21",
      existingTags: [],
      availableTags: -1,
    };

    const plan = buildChromeImportPlan(collections, "ws-1", new Set(), false, 0, tagOptions);

    const reactBm = plan.bookmarks.find(b => b.title === "React Documentation");
    expect(reactBm).toBeDefined();

    const devCol = plan.collections.find(c => c.name === "开发");
    expect(reactBm?.collectionId).toBe(devCol?.id);

    const tree = buildTagTree(plan.tags as Tag[], "en");
    expect(displayTagPath(tree, reactBm!.tags[0])).toBe("Chrome import 2026-10-21 › 开发 › 前端 › React");
  });

  test("direct root-folder bookmarks keep root-named collection", () => {
    const collections = parseChromeHTML(SAMPLE_CHROME_HTML);
    const tagOptions: ImportTagOptions = {
      enabled: true,
      rootName: "Chrome import 2026-10-21",
      existingTags: [],
      availableTags: -1,
    };

    const plan = buildChromeImportPlan(collections, "ws-1", new Set(), false, 0, tagOptions);

    const rootBm = plan.bookmarks.find(b => b.title === "Direct Root Bookmark");
    const rootCol = plan.collections.find(c => c.name === "书签栏");
    expect(rootBm?.collectionId).toBe(rootCol?.id);

    const tree = buildTagTree(plan.tags as Tag[], "en");
    expect(displayTagPath(tree, rootBm!.tags[0])).toBe("Chrome import 2026-10-21 › 书签栏");
  });

  test("no tag is created for a folder whose bookmarks were all skipped", () => {
    const collections = parseChromeHTML(SAMPLE_CHROME_HTML);
    // Mark React documentation as an existing duplicate URL
    const existingUrls = new Set(["https://react.dev"]);
    const tagOptions: ImportTagOptions = {
      enabled: true,
      rootName: "Chrome import 2026-10-21",
      existingTags: [],
      availableTags: -1,
    };

    const plan = buildChromeImportPlan(collections, "ws-1", existingUrls, true, 0, tagOptions);

    // React Documentation was skipped
    expect(plan.duplicatesSkipped).toBeGreaterThan(0);
    expect(plan.bookmarks.some(b => b.title === "React Documentation")).toBe(false);

    // Tag for React and 前端 should not exist since only React Doc was under them
    expect(plan.tags.some(t => t.name === "React")).toBe(false);
    expect(plan.tags.some(t => t.name === "前端")).toBe(false);
    // But 开发 still has "Direct Dev Bookmark"
    expect(plan.tags.some(t => t.name === "开发")).toBe(true);
  });

  test("invalid URLs are rejected and do not create tags", () => {
    const htmlWithInvalid = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><H3>书签栏</H3>
  <DL><p>
    <DT><H3>BadFolder</H3>
    <DL><p>
      <DT><A HREF="javascript:alert(1)">XSS</A>
    </DL><p>
  </DL><p>
</DL><p>`;
    const collections = parseChromeHTML(htmlWithInvalid);
    const tagOptions: ImportTagOptions = {
      enabled: true,
      rootName: "Chrome import 2026-10-21",
      existingTags: [],
      availableTags: -1,
    };

    const plan = buildChromeImportPlan(collections, "ws-1", new Set(), false, 0, tagOptions);

    expect(plan.rejectedUrls).toContain("javascript:alert(1)");
    expect(plan.bookmarks).toHaveLength(0);
    expect(plan.tags).toHaveLength(0);
  });

  test("calling without tagOptions preserves prior behavior", () => {
    const collections = parseChromeHTML(SAMPLE_CHROME_HTML);
    const plan = buildChromeImportPlan(collections, "ws-1", new Set(), false);

    expect(plan.tags).toHaveLength(0);
    expect(plan.provenance).toBeUndefined();
    expect(plan.bookmarks.every(b => b.tags.length === 0)).toBe(true);
  });
});
