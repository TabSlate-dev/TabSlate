// @ts-expect-error Bun provides this test module at runtime.
import { beforeEach, expect, test } from "bun:test";
import { runsInIsolatedProcess } from "./helpers/isolated-run";
import { installTagIdb } from "./helpers/tag-idb";
import type { TagMutationPlan } from "@/lib/tag-mutations";
import type { Tag } from "@/lib/types";

if (runsInIsolatedProcess(import.meta.filename)) {
  const db = installTagIdb();
  const persistence = await import("../lib/tag-persistence").catch(() => undefined);
  const tag: Tag = { id: "a", name: "a", color: "blue", seq: 2 };
  const plan: TagMutationPlan = { upserts: [{ ...tag, color: "red", seq: 0 }], tombstones: [], replacements: new Map() };
  beforeEach(() => { db.seed([tag]); db.state.fail = false; db.state.transactions = 0; });
  test("snapshot_compare_and_write_share_a_single_transaction", async () => {
    expect(persistence?.commitTagMutation).toBeFunction();
    await persistence?.commitTagMutation(plan, [tag]);
    expect(db.read("tags")).toEqual([{ ...tag, color: "red", seq: 0 }]); expect(db.state.transactions).toBe(1);
  });
  test("stale_snapshot_aborts_all_writes", async () => {
    expect(persistence?.commitTagMutation).toBeFunction(); db.seed([{ ...tag, color: "green" }]);
    await expect(persistence?.commitTagMutation(plan, [tag])).rejects.toBeInstanceOf(persistence?.TagMutationStaleError);
    expect(db.read("tags")).toEqual([{ ...tag, color: "green" }]);
  });
  test("transaction_failure_keeps_original_records", async () => {
    expect(persistence?.commitTagMutation).toBeFunction(); db.state.fail = true;
    await expect(persistence?.commitTagMutation(plan, [tag])).rejects.toThrow(); expect(db.read("tags")).toEqual([tag]);
  });
}
