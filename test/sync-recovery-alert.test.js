import { expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("@/hooks/use-translation", () => ({
  useTranslation: () => ({
    t: (key) => key === "workspaceLifecycle_legacyArchiveStateLimited"
      ? "Legacy archive state was limited"
      : key,
  }),
}));

const { SyncRecoveryAlert } = await import(
  `../components/ui/sync-recovery-alert.tsx?legacy=${Date.now()}`
);

test("renders the localized archival-loss notice as a visible alert", () => {
  const markup = renderToStaticMarkup(createElement(SyncRecoveryAlert, {
    targetWorkspaceName: null,
    legacyArchiveStateLimited: true,
  }));

  expect(markup).toContain('role="alert"');
  expect(markup).toContain("Legacy archive state was limited");
});
