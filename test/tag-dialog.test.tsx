// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import type { TagActionResult } from "@/lib/tag-mutations";
import type { Tag } from "@/lib/types";
import { createModuleReplacer } from "./helpers/module-replacer";
import {
  getBySelector,
  getByText,
  installAppModules,
  render,
  setupDom,
  submitForm,
  teardownDom,
  typeInto,
  type AppModules,
} from "./helpers/dom-environment";

const replacer = createModuleReplacer();
let app: AppModules;
let TagDialog: typeof import("@/components/dashboard/sidebar/tag-dialog").TagDialog;

beforeAll(async () => {
  setupDom();
  app = await installAppModules(replacer);
  ({ TagDialog } = await import("@/components/dashboard/sidebar/tag-dialog"));
});

afterAll(async () => {
  replacer.restore();
  await teardownDom();
});

const design: Tag = { id: "design", name: "Design", color: "bg-violet-500/10 text-violet-500", seq: 0 };

function renderDialog(initial: Tag | undefined, takenNames: string[]) {
  const submitted: Array<[string, string]> = [];
  const view = render(
    app,
    createElement(TagDialog, {
      open: true,
      onOpenChange: () => {},
      initial,
      takenNames,
      onSubmit: (name: string, color: string): Promise<TagActionResult> => {
        submitted.push([name, color]);
        return Promise.resolve({ ok: true });
      },
    }),
  );
  const input = getBySelector<HTMLInputElement>("#tag-name");
  const form = input.closest("form");
  if (!form) {
    throw new Error("tag dialog has no form");
  }
  return { view, input, form, submitted };
}

describe("TagDialog", () => {
  test("edit mode starts from the tag and saves the trimmed new name with its color", async () => {
    const dialog = renderDialog(design, ["Frontend"]);
    expect(getByText("tagDialog_editTitle")).toBeTruthy();
    expect(dialog.input.value).toBe("Design");

    typeInto(dialog.input, "  UI Design ");
    await submitForm(dialog.form);

    expect(dialog.submitted).toEqual([["UI Design", "bg-violet-500/10 text-violet-500"]]);
    dialog.view.unmount();
  });

  test("rejects an empty name", async () => {
    const dialog = renderDialog(undefined, []);
    typeInto(dialog.input, "   ");
    await submitForm(dialog.form);

    expect(getByText("tagDialog_errorEmpty")).toBeTruthy();
    expect(dialog.submitted).toEqual([]);
    dialog.view.unmount();
  });

  test("rejects a name another tag already uses, ignoring case", async () => {
    const dialog = renderDialog(undefined, ["  Frontend "]);
    typeInto(dialog.input, "frontend");
    await submitForm(dialog.form);

    expect(getByText("tagDialog_errorDuplicate")).toBeTruthy();
    expect(dialog.submitted).toEqual([]);
    dialog.view.unmount();
  });
  test("failed_async_save_keeps_input_and_dialog_open", async () => {
    const closed: boolean[] = [];
    const view = render(app, createElement(TagDialog, {
      open: true, takenNames: [], onOpenChange: (open: boolean) => { closed.push(open); },
      onSubmit: async (): Promise<TagActionResult> => ({ ok: false, error: "storage" }),
    }));
    const input = getBySelector<HTMLInputElement>("#tag-name");
    typeInto(input, "Keep this name");
    const form = input.closest("form");
    if (!form) { throw new Error("missing form"); }
    await submitForm(form);
    expect(input.value).toBe("Keep this name"); expect(closed).toEqual([]);
    expect(getByText("tagAction_errorStorage")).toBeTruthy(); view.unmount();
  });

  for (const oldResult of [{ ok: true }, { ok: false, error: "storage" }] satisfies TagActionResult[]) {
    test(`reopened_dialog_ignores_old_${oldResult.ok ? "success" : "failure"}_and_keeps_new_save_pending`, async () => {
      let resolveFirst: ((value: TagActionResult) => void) | undefined;
      let resolveSecond: ((value: TagActionResult) => void) | undefined;
      const first = new Promise<TagActionResult>(resolve => { resolveFirst = resolve; });
      const second = new Promise<TagActionResult>(resolve => { resolveSecond = resolve; });
      const closed: boolean[] = [];
      let submissions = 0;
      const props = {
        takenNames: [], onOpenChange: (open: boolean) => { closed.push(open); },
        onSubmit: () => ++submissions === 1 ? first : second,
      };
      const view = render(app, createElement(TagDialog, { ...props, open: true }));
      try {
        typeInto(getBySelector<HTMLInputElement>("#tag-name"), "First draft");
        await submitForm(getBySelector("form"));
        view.rerender(createElement(TagDialog, { ...props, open: false }));
        view.rerender(createElement(TagDialog, { ...props, open: true }));
        typeInto(getBySelector<HTMLInputElement>("#tag-name"), "Second draft");
        await submitForm(getBySelector("form"));
        await act(async () => { resolveFirst?.(oldResult); });
        expect(closed).toEqual([]);
        expect(getBySelector<HTMLInputElement>("#tag-name").value).toBe("Second draft");
        expect(document.querySelector('[role="alert"]') !== null).toBe(false);
        expect(getBySelector<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true);
        expect(submissions).toBe(2);
        await act(async () => { resolveSecond?.({ ok: true }); });
        expect(closed).toEqual([false]);
      } finally { view.unmount(); }
    });
  }

});
