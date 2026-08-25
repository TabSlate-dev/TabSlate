import { describe, expect, test } from "bun:test";
import en from "../public/_locales/en/messages.json";
import zhCN from "../public/_locales/zh_CN/messages.json";

describe("sync recovery messages", () => {
  test("defines migration and conflict copy", () => {
    expect(en.sync_guestDataMerged.message).toContain("$1");
    expect(zhCN.sync_guestDataMerged.message).toContain("$1");
    expect(en.sync_noMigrationTarget.message.length).toBeGreaterThan(0);
    expect(zhCN.sync_noMigrationTarget.message.length).toBeGreaterThan(0);
    expect(en.sync_invalidParentConflict.message.length).toBeGreaterThan(0);
    expect(zhCN.sync_invalidParentConflict.message.length).toBeGreaterThan(0);
    expect(en.sync_quotaConflict.message.length).toBeGreaterThan(0);
    expect(zhCN.sync_quotaConflict.message.length).toBeGreaterThan(0);
    expect(en.workspaceLifecycle_legacyArchiveStateLimited.message.length).toBeGreaterThan(0);
    expect(zhCN.workspaceLifecycle_legacyArchiveStateLimited.message.length).toBeGreaterThan(0);
  });
});
