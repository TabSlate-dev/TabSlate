// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createModuleReplacer } from "./helpers/module-replacer";
import { installAppModules, render, setupDom, teardownDom, type AppModules } from "./helpers/dom-environment";

const replacer = createModuleReplacer();
let app: AppModules;
let BookmarkCover: typeof import("@/components/dashboard/bookmark-cover").BookmarkCover;
let coverHost: typeof import("@/components/dashboard/bookmark-cover").coverHost;
let coverToneIndex: typeof import("@/components/dashboard/bookmark-cover").coverToneIndex;

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ BookmarkCover, coverHost, coverToneIndex } = await import("@/components/dashboard/bookmark-cover"));
});
afterAll(async () => {
  replacer.restore();
  await teardownDom();
});

describe("BookmarkCover", () => {
  test("shows the cover lazily, without a referrer, as decoration", () => {
    const view = render(app, createElement(BookmarkCover, {
      imageUrl: "https://cdn.example.com/a.png", url: "https://example.com/a", favicon: "",
    }));
    const image = view.container.querySelector("img");

    expect(image?.getAttribute("src")).toBe("https://cdn.example.com/a.png");
    expect(image?.getAttribute("alt")).toBe("");
    expect(image?.getAttribute("loading")).toBe("lazy");
    expect(image?.getAttribute("decoding")).toBe("async");
    expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(image?.getAttribute("draggable")).toBe("false");
    expect(view.container.querySelector("[data-cover-placeholder]")).toBeNull();
    view.unmount();
  });

  test("shows a placeholder with the site's host when there is no cover", () => {
    const view = render(app, createElement(BookmarkCover, { url: "https://www.example.com/a", favicon: "" }));
    const placeholder = view.container.querySelector("[data-cover-placeholder]");

    expect(placeholder?.getAttribute("aria-hidden")).toBe("true");
    expect(placeholder?.textContent).toBe("example.com");
    view.unmount();
  });

  test("switches to the placeholder after a load error and does not retry when mounted again", () => {
    const props = { imageUrl: "https://cdn.example.com/broken.png", url: "https://example.com/b", favicon: "" };
    const first = render(app, createElement(BookmarkCover, props));
    const image = first.container.querySelector("img");
    act(() => {
      image?.dispatchEvent(new Event("error"));
    });
    expect(first.container.querySelector("[data-cover-placeholder]")).not.toBeNull();
    first.unmount();

    const second = render(app, createElement(BookmarkCover, props));
    expect(second.container.querySelector('img[src="https://cdn.example.com/broken.png"]')).toBeNull();
    expect(second.container.querySelector("[data-cover-placeholder]")).not.toBeNull();
    second.unmount();
  });

  test("bookmarks on one site share a placeholder color", () => {
    const first = render(app, createElement(BookmarkCover, { url: "https://example.com/1", favicon: "" }));
    const second = render(app, createElement(BookmarkCover, { url: "https://www.example.com/2", favicon: "" }));

    expect(first.container.querySelector("[data-cover-placeholder]")?.className)
      .toBe(second.container.querySelector("[data-cover-placeholder]")?.className);
    first.unmount();
    second.unmount();
  });
});

describe("placeholder colors", () => {
  test("a host always maps to the same tone, and hosts spread across tones", () => {
    expect(coverToneIndex("example.com")).toBe(coverToneIndex("example.com"));
    const tones = new Set(["a.com", "b.org", "c.net", "d.io", "e.dev", "f.app", "g.co", "h.me"].map(coverToneIndex));
    expect(tones.size).toBeGreaterThan(1);
  });

  test("the host drops www. and is empty for an address that does not parse", () => {
    expect(coverHost("https://www.example.com/x")).toBe("example.com");
    expect(coverHost("not a url")).toBe("");
  });
});
