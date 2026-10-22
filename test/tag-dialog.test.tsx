// @ts-expect-error Bun provides this test module at runtime.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import type { TagActionResult } from "@/lib/tag-mutations";
import type { Tag } from "@/lib/types";
import { createModuleReplacer } from "./helpers/module-replacer";
import {
  click,
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

function renderDialog(initial: Tag | undefined, takenNames: string[] = [], initialParentId?: string) {
  const submitted: Array<{ name: string; color: string; parentId?: string }> = [];
  const view = render(
    app,
    createElement(TagDialog, {
      open: true,
      onOpenChange: () => {},
      initial,
      initialParentId,
      takenNames,
      onSubmit: (input: { name: string; color: string; parentId?: string }): Promise<TagActionResult> => {
        submitted.push(input);
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

    expect(dialog.submitted).toEqual([
      { name: "UI Design", color: "bg-violet-500/10 text-violet-500", parentId: undefined },
    ]);
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

  test("rejects a name another sibling tag already uses, ignoring case", async () => {
    const dialog = renderDialog(undefined, ["  Frontend "]);
    typeInto(dialog.input, "frontend");
    await submitForm(dialog.form);

    expect(getByText("tagDialog_errorDuplicate")).toBeTruthy();
    expect(dialog.submitted).toEqual([]);
    dialog.view.unmount();
  });

  test("creating path under parent passes name and parentId to onSubmit", async () => {
    const dialog = renderDialog(undefined, [], "prog");
    typeInto(dialog.input, "后端/Go");
    await submitForm(dialog.form);

    expect(dialog.submitted).toEqual([
      expect.objectContaining({ name: "后端/Go", parentId: "prog" }),
    ]);
    dialog.view.unmount();
  });

  test("child creation at depth five shows error and rejects submission", async () => {
    const tags = [
      { id: "l1", name: "L1", color: "blue", seq: 0 },
      { id: "l2", name: "L2", parentId: "l1", color: "blue", seq: 0 },
      { id: "l3", name: "L3", parentId: "l2", color: "blue", seq: 0 },
      { id: "l4", name: "L4", parentId: "l3", color: "blue", seq: 0 },
      { id: "l5", name: "L5", parentId: "l4", color: "blue", seq: 0 },
    ];
    app.useWorkspaceStore.setState({ tags });
    const dialog = renderDialog(undefined, [], "l5");
    typeInto(dialog.input, "L6");
    await submitForm(dialog.form);

    expect(dialog.submitted).toEqual([]);
    expect(getByText("tagAction_targetDepth")).toBeTruthy();
    dialog.view.unmount();
  });

  test("legacy unchanged slash/overlength name permits color and move edits without trimming or validation error", async () => {
    const legacyTag: Tag = {
      id: "legacy",
      name: "  legacy/tag/with/slashes/and spaces  ",
      color: "bg-blue-500/10 text-blue-500",
      seq: 0,
    };
    const dialog = renderDialog(legacyTag, []);
    // Do not touch input name; change color
    click(getBySelector('[aria-label="tagDialog_colorOption[2]"]'));
    await submitForm(dialog.form);

    expect(dialog.submitted).toEqual([
      {
        name: "  legacy/tag/with/slashes/and spaces  ",
        color: expect.any(String),
        parentId: undefined,
      },
    ]);
    dialog.view.unmount();
  });

  test("failed_async_save_keeps_input_and_dialog_open", async () => {
    const closed: boolean[] = [];
    const view = render(
      app,
      createElement(TagDialog, {
        open: true,
        takenNames: [],
        onOpenChange: (open: boolean) => {
          closed.push(open);
        },
        onSubmit: async (): Promise<TagActionResult> => ({ ok: false, error: "storage" }),
      }),
    );
    const input = getBySelector<HTMLInputElement>("#tag-name");
    typeInto(input, "Keep this name");
    const form = input.closest("form");
    if (!form) {
      throw new Error("missing form");
    }
    await submitForm(form);
    expect(input.value).toBe("Keep this name");
    expect(closed).toEqual([]);
    expect(getByText("tagAction_errorStorage")).toBeTruthy();
    view.unmount();
  });

  for (const oldResult of [{ ok: true }, { ok: false, error: "storage" }] satisfies TagActionResult[]) {
    test(`reopened_dialog_ignores_old_${oldResult.ok ? "success" : "failure"}_and_keeps_new_save_pending`, async () => {
      let resolveFirst: ((value: TagActionResult) => void) | undefined;
      let resolveSecond: ((value: TagActionResult) => void) | undefined;
      const first = new Promise<TagActionResult>((resolve) => {
        resolveFirst = resolve;
      });
      const second = new Promise<TagActionResult>((resolve) => {
        resolveSecond = resolve;
      });
      const closed: boolean[] = [];
      let submissions = 0;
      const props = {
        takenNames: [],
        onOpenChange: (open: boolean) => {
          closed.push(open);
        },
        onSubmit: () => (++submissions === 1 ? first : second),
      };
      const view = render(app, createElement(TagDialog, { ...props, open: true }));
      try {
        typeInto(getBySelector<HTMLInputElement>("#tag-name"), "First draft");
        await submitForm(getBySelector("form"));
        view.rerender(createElement(TagDialog, { ...props, open: false }));
        view.rerender(createElement(TagDialog, { ...props, open: true }));
        typeInto(getBySelector<HTMLInputElement>("#tag-name"), "Second draft");
        await submitForm(getBySelector("form"));
        await act(async () => {
          resolveFirst?.(oldResult);
        });
        expect(closed).toEqual([]);
        expect(getBySelector<HTMLInputElement>("#tag-name").value).toBe("Second draft");
        expect(document.querySelector('[role="alert"]') !== null).toBe(false);
        expect(getBySelector<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true);
        expect(submissions).toBe(2);
        await act(async () => {
          resolveSecond?.({ ok: true });
        });
        expect(closed).toEqual([false]);
      } finally {
        view.unmount();
      }
    });
  }
});
