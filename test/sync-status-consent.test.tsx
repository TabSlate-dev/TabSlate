// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

let accountDataConsent: boolean | null = false;

mock.module("@/hooks/use-translation", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));
mock.module("@/hooks/use-account-data-consent", () => ({
  useAccountDataConsent: () => accountDataConsent,
}));

const { SyncStatusIndicator } = await import("../components/dashboard/sidebar/sync-status");

function renderIndicator(isGuest: boolean) {
  return renderToStaticMarkup(createElement(SyncStatusIndicator, {
    status: "idle",
    errorMessage: null,
    onForceSync: () => undefined,
    isGuest,
    onRegister: () => undefined,
  }));
}

describe("SyncStatusIndicator account data consent", () => {
  test("signed-in users without consent see sync paused with a way to allow it", () => {
    accountDataConsent = false;

    const markup = renderIndicator(false);

    expect(markup).toContain("sync_paused");
    expect(markup).toContain("sync_allowSync");
    expect(markup).not.toContain("sync_syncNow");
  });

  test("granted consent keeps the normal sync controls", () => {
    accountDataConsent = true;

    const markup = renderIndicator(false);

    expect(markup).toContain("sync_idle");
    expect(markup).toContain("sync_syncNow");
    expect(markup).not.toContain("sync_paused");
  });

  test("guests keep the register prompt whatever the consent state", () => {
    accountDataConsent = false;

    const markup = renderIndicator(true);

    expect(markup).toContain("sync_registerNow");
    expect(markup).not.toContain("sync_paused");
  });
});
