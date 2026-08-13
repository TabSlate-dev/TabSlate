// @ts-expect-error Bun provides this test module at runtime.
import { expect, test } from "bun:test";
import { Children, isValidElement } from "react";

import {
  DialogContent,
  getDialogOverlayClassName,
} from "../components/ui/dialog";

function getFirstOverlayClassName(overlayClassName?: string) {
  const content = DialogContent({ children: null, overlayClassName });
  const [firstChild] = Children.toArray(content.props.children);

  if (!isValidElement<{ className?: string }>(firstChild)) {
    throw new Error("DialogContent did not render an overlay child");
  }

  return firstChild.props.className;
}

test("forwards an optional overlay class without changing the default overlay", () => {
  expect(getFirstOverlayClassName("backdrop-blur-sm")).toBe("backdrop-blur-sm");
  expect(getDialogOverlayClassName()).toBe(
    "fixed inset-0 z-50 bg-foreground/20 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
  );
});
