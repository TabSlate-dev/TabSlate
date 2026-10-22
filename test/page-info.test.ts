// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { setupDom, teardownDom } from "./helpers/dom-environment";
import { readPageInfo, requestPageInfo } from "@/lib/page-info";

const originalChrome = Reflect.get(globalThis, "chrome");

beforeAll(() => {
  setupDom();
});
afterEach(() => {
  Reflect.set(globalThis, "chrome", originalChrome);
  document.head.innerHTML = "";
});
afterAll(async () => {
  await teardownDom();
});

function parse(head: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><html><head>${head}</head><body></body></html>`, "text/html");
}

describe("readPageInfo", () => {
  test("reads the Open Graph tags and resolves the cover and the icon against the page", () => {
    const info = readPageInfo(parse(`
      <title>Doc title</title>
      <meta property="og:title" content=" OG title ">
      <meta property="og:description" content="OG description">
      <meta name="description" content="Meta description">
      <meta property="og:image" content="/images/cover.png">
      <link rel="icon" href="/static/icon.png">`), "https://example.com/posts/1");

    expect(info).toEqual({
      title: "Doc title",
      url: "https://example.com/posts/1",
      selectedText: "",
      favicon: "https://example.com/static/icon.png",
      ogTitle: "OG title",
      metaDescription: "OG description",
      ogImage: "https://example.com/images/cover.png",
    });
  });

  test("falls back to twitter:image and to the meta description when Open Graph values are empty", () => {
    const info = readPageInfo(parse(`
      <meta property="og:description" content="  ">
      <meta name="description" content="Meta description">
      <meta name="twitter:image" content="https://cdn.example.com/t.png">`), "https://example.com/");

    expect(info.metaDescription).toBe("Meta description");
    expect(info.ogImage).toBe("https://cdn.example.com/t.png");
    expect(info.ogTitle).toBe("");
  });

  test("reports no cover and the site's favicon.ico when the page declares neither", () => {
    const info = readPageInfo(parse("<title>Plain</title>"), "https://example.com/a/b");
    expect(info.ogImage).toBe("");
    expect(info.favicon).toBe("https://example.com/favicon.ico");
  });

  test("does not invent a favicon URL for an opaque page origin", () => {
    const info = readPageInfo(parse("<title>Blank</title>"), "about:blank");
    expect(info.favicon).toBe("");
  });

  test("resolves relative URLs against the page's base element", () => {
    const info = readPageInfo(parse(`
      <base href="https://cdn.example.com/assets/">
      <meta property="og:image" content="cover.png">`), "https://example.com/post");
    expect(info.ogImage).toBe("https://cdn.example.com/assets/cover.png");
  });

  test("runs from its own source text and reads the current page, as executeScript runs it", () => {
    document.head.innerHTML = '<meta property="og:image" content="https://cdn.example.com/live.png">';
    document.title = "Live page";
    const standalone: unknown = new Function(`return (${readPageInfo.toString()})`)();
    if (typeof standalone !== "function") {
      throw new Error("the reader's source did not produce a function");
    }

    const info: unknown = standalone();

    expect(info).toMatchObject({ title: "Live page", url: location.href, ogImage: "https://cdn.example.com/live.png" });
  });
});

describe("requestPageInfo", () => {
  const injected = {
    title: "Injected", url: "https://example.com/", selectedText: "", favicon: "",
    ogTitle: "", metaDescription: "", ogImage: "https://cdn.example.com/i.png",
  };

  function stubChrome(sendMessage: () => Promise<unknown>, executeScript: () => Promise<unknown[]>) {
    const calls = { executeScript: mock(executeScript) };
    Reflect.set(globalThis, "chrome", {
      tabs: { sendMessage: mock(sendMessage) },
      scripting: { executeScript: calls.executeScript },
    });
    return calls;
  }

  test("uses the content script's answer without injecting", async () => {
    const calls = stubChrome(async () => ({ ...injected, title: "From content script" }), async () => []);
    expect((await requestPageInfo(7, { allowInjection: true }))?.title).toBe("From content script");
    expect(calls.executeScript).not.toHaveBeenCalled();
  });

  test("fills fields an answer leaves out with empty strings", async () => {
    stubChrome(async () => ({ title: "Partial", url: "https://example.com/" }), async () => []);
    expect(await requestPageInfo(7, { allowInjection: false })).toEqual({
      title: "Partial", url: "https://example.com/", selectedText: "", favicon: "",
      ogTitle: "", metaDescription: "", ogImage: "",
    });
  });

  test("runs the reader in the tab when the content script does not answer", async () => {
    const calls = stubChrome(async () => {
      throw new Error("Receiving end does not exist.");
    }, async () => [{ frameId: 0, documentId: "doc", result: injected }]);

    expect(await requestPageInfo(7, { allowInjection: true })).toEqual(injected);
    expect(calls.executeScript).toHaveBeenCalledWith({ target: { tabId: 7 }, func: readPageInfo });
  });

  test("does not inject without allowInjection", async () => {
    const calls = stubChrome(async () => undefined, async () => [{ frameId: 0, documentId: "doc", result: injected }]);
    expect(await requestPageInfo(7, { allowInjection: false })).toBeNull();
    expect(calls.executeScript).not.toHaveBeenCalled();
  });

  test("resolves to null when injection fails too", async () => {
    stubChrome(async () => {
      throw new Error("Receiving end does not exist.");
    }, async () => {
      throw new Error("Cannot access contents of the page.");
    });
    expect(await requestPageInfo(7, { allowInjection: true })).toBeNull();
  });
});
