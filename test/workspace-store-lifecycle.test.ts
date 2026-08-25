// @ts-expect-error Bun provides this test module at runtime.
import { afterEach, describe, expect, test } from "bun:test";
import {
  purgeWorkspaceThroughActiveLifecycle,
  registerSyncLifecycle,
  unregisterSyncLifecycle,
  wakeActiveWorkspaceLifecycle,
} from "../lib/sync-lifecycle";

describe("registered Workspace lifecycle runtime", () => {
  const calls: string[] = [];
  const lifecycle = {
    async retire(): Promise<void> {},
    async wakeWorkspaceLifecycle(workspaceId: string): Promise<void> {
      calls.push(`wake:${workspaceId}`);
    },
    async purgeWorkspace(workspaceId: string): Promise<{ status: "completed" }> {
      calls.push(`purge:${workspaceId}`);
      return { status: "completed" };
    },
  };

  afterEach(() => {
    unregisterSyncLifecycle(lifecycle);
    calls.length = 0;
  });

  test("wakes only the registered runtime for one aggregate", async () => {
    registerSyncLifecycle(lifecycle);
    expect(await wakeActiveWorkspaceLifecycle("workspace-1")).toBe(true);
    expect(calls).toEqual(["wake:workspace-1"]);
  });

  test("returns the registered runtime purge result and reports absence", async () => {
    expect(await purgeWorkspaceThroughActiveLifecycle("workspace-1")).toBeUndefined();
    registerSyncLifecycle(lifecycle);
    expect(await purgeWorkspaceThroughActiveLifecycle("workspace-1")).toEqual({ status: "completed" });
    expect(calls).toEqual(["purge:workspace-1"]);
  });
});
