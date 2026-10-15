// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { createModuleReplacer, importFresh } from "./helpers/module-replacer";
import { click, getBySelector, render, setupDom, teardownDom, wait } from "./helpers/dom-environment";

const replacer = createModuleReplacer();
const originalChrome = Reflect.get(globalThis, "chrome");
let permissionGranted = false;
const resyncPreferences = mock(async () => {});
let createRoot: typeof import("react-dom/client").createRoot;
let usePreferenceSyncConsent: typeof import("@/hooks/use-preference-sync-consent").usePreferenceSyncConsent;

beforeAll(async () => {
  setupDom();
  Reflect.set(globalThis, "chrome", {
    permissions: {
      contains: async () => permissionGranted,
      request: async () => {
        permissionGranted = true;
        return true;
      },
      remove: async () => {
        permissionGranted = false;
        return true;
      },
      onAdded: { addListener: () => {}, removeListener: () => {} },
      onRemoved: { addListener: () => {}, removeListener: () => {} },
    },
  });
  const realEnv = await importFresh<typeof import("@/lib/browser/env")>("lib/browser/env.ts");
  const reactDomClient = await importFresh<typeof import("react-dom/client")>("node_modules/react-dom/client.js");
  await replacer.replace("react-dom/client", reactDomClient);
  await replacer.replace("@/lib/browser/env", { ...realEnv, isFirefoxBuild: () => true });
  await replacer.replace("@/store/settings-store", {
    useSettingsStore: { getState: () => ({ resyncPreferences }) },
  });
  createRoot = reactDomClient.createRoot;
  ({ usePreferenceSyncConsent } = await importFresh<typeof import("@/hooks/use-preference-sync-consent")>(
    "hooks/use-preference-sync-consent.ts",
  ));
});

afterAll(async () => {
  replacer.restore();
  Reflect.set(globalThis, "chrome", originalChrome);
  await teardownDom();
});

function Probe() {
  const { granted, setGranted } = usePreferenceSyncConsent();
  return createElement(
    "button",
    { id: "toggle", onClick: () => setGranted(!granted) },
    String(granted),
  );
}

describe("usePreferenceSyncConsent", () => {
  test("reflects, grants and withdraws the Firefox permission", async () => {
    const view = render({ createRoot }, createElement(Probe));
    await wait(0);
    const toggle = getBySelector("#toggle");
    expect(toggle.textContent).toBe("false");

    click(toggle);
    await wait(0);
    expect(toggle.textContent).toBe("true");
    expect(resyncPreferences).toHaveBeenCalledTimes(1);

    click(toggle);
    await wait(0);
    expect(toggle.textContent).toBe("false");
    expect(resyncPreferences).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});
