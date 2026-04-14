/**
 * Procaptcha React wrapper with self-hosted server support.
 *
 * Inlines createRenderer / loadRenderFunction from @prosopo/procaptcha-wrapper
 * because that package only exports its root (renderProcaptcha) and the deep
 * path ./dist/render/renderer.js is not listed in its exports field.
 */
import { useRef, useEffect } from "react";

type RenderOptions = {
  siteKey: string;
  callback?: (token: string) => void;
  theme?: string;
  language?: string;
  captchaType?: string;
};

type RenderFunction = (element: HTMLElement, options: RenderOptions) => Promise<void>;

async function loadRenderFunction(scriptUrl: string, scriptId: string): Promise<RenderFunction> {
  await new Promise<void>((resolve, reject) => {
    if (document.getElementById(scriptId)) {
      resolve();
      return;
    }
    const script = Object.assign(document.createElement("script"), {
      src: scriptUrl,
      id: scriptId,
      type: "module",
      async: true,
      defer: true,
      onload: resolve,
      onerror: reject,
    });
    document.head.appendChild(script);
  });
  const w = window as unknown as { procaptcha?: { render?: RenderFunction } };
  if (!w.procaptcha?.render) {
    throw new Error("Render script does not contain the render function");
  }
  return w.procaptcha.render;
}

function createRenderer(settings: { scriptUrl: string; scriptId: string }) {
  let renderFn: RenderFunction | undefined;
  return async (element: HTMLElement, options: RenderOptions) => {
    if (!renderFn) {
      renderFn = await loadRenderFunction(settings.scriptUrl, settings.scriptId);
    }
    await renderFn(element, { ...options });
  };
}

const DEFAULT_SCRIPT_URL = "https://js.prosopo.io/js/procaptcha.bundle.js";

interface ProcaptchaProps {
  siteKey: string;
  /** Called with the procaptcha token when the user passes verification. */
  callback?: (token: string) => void;
  theme?: "light" | "dark";
  language?: string;
  captchaType?: string;
  /**
   * Base URL of a self-hosted Prosopo server.
   * When set, the JS bundle is loaded from `${serverUrl}/js/procaptcha.bundle.js`.
   * Leave empty to use the official Prosopo CDN.
   */
  serverUrl?: string;
}

export function Procaptcha({
  siteKey,
  callback,
  theme,
  language,
  captchaType,
  serverUrl,
}: ProcaptchaProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;

    const scriptUrl = serverUrl
      ? `${serverUrl.replace(/\/$/, "")}/js/procaptcha.bundle.js`
      : DEFAULT_SCRIPT_URL;

    const render = createRenderer({
      scriptUrl,
      scriptId: "procaptcha-bundle",
    });

    render(ref.current, {
      siteKey,
      callback,
      theme,
      language,
      captchaType,
    } as Parameters<typeof render>[1]);
  }, [siteKey, callback, theme, language, captchaType, serverUrl]);

  return <div ref={ref} />;
}
