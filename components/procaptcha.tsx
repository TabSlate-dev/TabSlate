/**
 * Procaptcha iframe wrapper for Chrome MV3 extensions.
 *
 * MV3 enforces script-src 'self' and cannot whitelist external script domains,
 * so we cannot load the Prosopo CDN bundle directly. Instead, the extension
 * embeds an <iframe> pointing to the server's /captcha/widget endpoint. That
 * page (a normal web origin) loads the Prosopo bundle freely, then posts the
 * solved token back via postMessage.
 *
 * When Prosopo updates their JS bundle, only the server needs redeploying —
 * the extension requires no changes.
 */
import { useEffect, useRef, useCallback, useState } from "react";

interface ProcaptchaProps {
  siteKey: string;
  /** TabSlate server base URL — the same one used for API calls. */
  serverUrl: string;
  /** Called with the procaptcha token once the user passes verification. */
  onToken: (token: string) => void;
  theme?: "light" | "dark";
  /** Captcha type configured for this site key in the Prosopo dashboard.
   *  Set via VITE_PROSOPO_CAPTCHA_TYPE. Omit to use Prosopo's default. */
  captchaType?: "frictionless" | "pow" | "image";
}

const MIN_HEIGHT = 78;

export function Procaptcha({ siteKey, serverUrl, onToken, theme = "light", captchaType }: ProcaptchaProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(MIN_HEIGHT);

  const base = serverUrl.replace(/\/$/, "");
  const params = new URLSearchParams({ siteKey, theme });
  if (captchaType) params.set("captchaType", captchaType);
  const src = `${base}/captcha/widget?${params}`;
  const widgetOrigin = new URL(src).origin;

  const handleMessage = useCallback(
    (e: MessageEvent) => {
      if (e.origin !== widgetOrigin) return;
      if (e.data?.type === "procaptcha-token" && typeof e.data.token === "string") {
        onToken(e.data.token);
      }
      if (e.data?.type === "procaptcha-resize" && typeof e.data.height === "number") {
        setHeight(Math.max(MIN_HEIGHT, e.data.height));
      }
    },
    [widgetOrigin, onToken],
  );

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  return (
    <iframe
      ref={iframeRef}
      src={src}
      title="CAPTCHA verification"
      allowTransparency={true}
      style={{ border: "none", width: "100%", height, background: "transparent" }}
    />
  );
}
