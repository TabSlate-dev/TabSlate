// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { setupDom, teardownDom } from "./helpers/dom-environment";
import { FETCH_DETAILS_MAX_BYTES, fetchPageMetadata, siteAccessPattern } from "@/lib/page-metadata";

// happy-dom installs its own fetch; each test replaces it and afterEach puts it back.
let originalFetch: unknown;
let requests: Array<{ url: string; init: RequestInit | undefined }> = [];

beforeAll(() => {
  setupDom();
  originalFetch = Reflect.get(globalThis, "fetch");
});
afterEach(() => {
  Reflect.set(globalThis, "fetch", originalFetch);
  requests = [];
});
afterAll(async () => {
  await teardownDom();
});

function serve(respond: (url: string, init: RequestInit | undefined) => Promise<Response>): void {
  Reflect.set(globalThis, "fetch", async (input: string, init?: RequestInit) => {
    requests.push({ url: input, init });
    return respond(input, init);
  });
}

function html(head: string, contentType = "text/html; charset=utf-8"): () => Promise<Response> {
  return async () => new Response(`<!doctype html><html><head>${head}</head><body></body></html>`, { headers: { "content-type": contentType } });
}

describe("fetchPageMetadata", () => {
  test("requests the page without cookies and reads its Open Graph details", async () => {
    serve(html('<title>Doc</title><meta property="og:title" content="OG title"><meta property="og:description" content="OG description"><meta property="og:image" content="https://cdn.example.com/c.png">'));

    expect(await fetchPageMetadata("https://example.com/a")).toEqual({
      status: "ok",
      metadata: { title: "OG title", description: "OG description", imageUrl: "https://cdn.example.com/c.png" },
    });
    expect(requests[0]?.init?.credentials).toBe("omit");
    expect(requests[0]?.init?.redirect).toBe("follow");
  });

  test("falls back to the title element, the meta description and twitter:image", async () => {
    serve(html('<title>Doc title</title><meta name="description" content="Meta description"><meta name="twitter:image" content="https://cdn.example.com/t.png">'));

    expect(await fetchPageMetadata("https://example.com/a")).toEqual({
      status: "ok",
      metadata: { title: "Doc title", description: "Meta description", imageUrl: "https://cdn.example.com/t.png" },
    });
  });

  test("resolves a relative cover against the final response URL", async () => {
    serve(async () => {
      const response = new Response('<html><head><meta property="og:image" content="/c.png"></head></html>', { headers: { "content-type": "text/html" } });
      Object.defineProperty(response, "url", { value: "https://final.example.com/post" });
      return response;
    });

    const result = await fetchPageMetadata("https://example.com/redirecting");

    expect(result.status === "ok" ? result.metadata.imageUrl : "").toBe("https://final.example.com/c.png");
  });

  test("decodes the charset a meta tag declares when the header has none", async () => {
    const encoder = new TextEncoder();
    const bytes = new Uint8Array([
      ...encoder.encode('<html><head><meta charset="gbk"><title>'),
      0xc4, 0xe3, 0xba, 0xc3, // 你好 in GBK
      ...encoder.encode("</title></head></html>"),
    ]);
    serve(async () => new Response(bytes, { headers: { "content-type": "text/html" } }));

    const result = await fetchPageMetadata("https://example.cn/");

    expect(result.status === "ok" ? result.metadata.title : "").toBe("你好");
  });

  test("uses a meta charset rather than charset text in a script, with the header taking precedence", async () => {
    const encoder = new TextEncoder();
    const bytes = new Uint8Array([
      ...encoder.encode('<html><head><script>const encoding = "charset=utf-8";</script><meta charset="gbk"><title>'),
      0xc4, 0xe3, 0xba, 0xc3,
      ...encoder.encode("</title></head></html>"),
    ]);
    serve(async () => new Response(bytes, { headers: { "content-type": "text/html" } }));
    const result = await fetchPageMetadata("https://example.cn/");
    expect(result.status === "ok" ? result.metadata.title : "").toBe("你好");

    serve(html('<meta charset="gbk"><title>你好</title>', "application/xhtml+xml; charset=utf-8"));
    const headerResult = await fetchPageMetadata("https://example.cn/");
    expect(headerResult.status === "ok" ? headerResult.metadata.title : "").toBe("你好");
  });

  test("reads no more than the size limit of a huge page", async () => {
    let pulled = 0;
    const filler = new Uint8Array(64 * 1024).fill(0x61);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const head = new TextEncoder().encode('<html><head><meta property="og:title" content="Huge"></head><body>');
        pulled += head.length;
        controller.enqueue(head);
      },
      pull(controller) {
        pulled += filler.length;
        controller.enqueue(filler);
      },
    });
    serve(async () => new Response(stream, { headers: { "content-type": "text/html" } }));

    const result = await fetchPageMetadata("https://huge.example.com/");

    expect(result).toEqual({ status: "ok", metadata: { title: "Huge", description: "", imageUrl: "" } });
    expect(pulled).toBeLessThan(FETCH_DETAILS_MAX_BYTES + 4 * filler.length);
  });

  test("reports pages that are not HTML, failed responses and pages without details", async () => {
    serve(async () => new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } }));
    expect(await fetchPageMetadata("https://example.com/a.pdf")).toEqual({ status: "error", reason: "not-html" });

    serve(async () => new Response("missing", { status: 404, headers: { "content-type": "text/html" } }));
    expect(await fetchPageMetadata("https://example.com/missing")).toEqual({ status: "error", reason: "http" });

    serve(html(""));
    expect(await fetchPageMetadata("https://example.com/empty")).toEqual({ status: "error", reason: "no-metadata" });
  });

  test("reports network errors and timeouts", async () => {
    serve(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await fetchPageMetadata("https://down.example.com/")).toEqual({ status: "error", reason: "network" });

    serve((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    expect(await fetchPageMetadata("https://slow.example.com/", 20)).toEqual({ status: "error", reason: "timeout" });
  });
});

test("site access asks for the page's host on its scheme, without the port or path", () => {
  expect(siteAccessPattern("https://www.example.com:8443/a/b?c=1")).toBe("https://www.example.com/*");
  expect(siteAccessPattern("http://localhost:3000/")).toBe("http://localhost/*");
});
