// @ts-expect-error Bun provides this test module at runtime.
import { expect, test } from "bun:test";

import { getDialogOverlayClassName } from "../components/ui/dialog";

test("forwards an optional overlay class without changing the default overlay", () => {
  expect(getDialogOverlayClassName("backdrop-blur-sm")).toContain(
    "backdrop-blur-sm"
  );
  expect(getDialogOverlayClassName()).toBe(
    "fixed inset-0 z-50 bg-foreground/20 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
  );
});
