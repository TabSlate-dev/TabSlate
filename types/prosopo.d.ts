declare module "@prosopo/react-procaptcha-wrapper" {
  import type { ComponentType } from "react";

  interface ProcaptchaComponentProps {
    siteKey: string;
    theme?: "light" | "dark";
    callback?: (token: string) => void;
    language?: string;
    captchaType?: string;
    htmlAttributes?: Record<string, unknown>;
  }

  export const ProcaptchaComponent: ComponentType<ProcaptchaComponentProps>;
}

declare module "@prosopo/procaptcha-wrapper/dist/render/renderer.js" {
  type RendererFunction = (
    element: HTMLElement,
    options: Record<string, unknown>,
  ) => Promise<void>;

  interface RendererSettings {
    scriptUrl: string;
    scriptId: string;
  }

  export const createRenderer: (settings: RendererSettings) => RendererFunction;
}
