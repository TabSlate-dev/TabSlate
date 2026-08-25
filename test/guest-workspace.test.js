import { describe, expect, test } from "bun:test";
import {
  GUEST_WORKSPACE_PROVENANCE_KEY,
  createGuestWorkspaceSeed,
  isUntouchedGuestWorkspace,
  planGuestWorkspaceMigration,
  selectGuestMigrationTarget,
} from "../lib/guest-workspace";

function makeBookmark(id, collectionId) {
  return {
    id,
    title: `Bookmark ${id}`,
    url: `https://${id}.example.com`,
    description: "",
    favicon: "",
    collectionId,
    tags: [],
    createdAt: "2026-08-23T00:00:00.000Z",
    isFavorite: false,
    seq: 0,
  };
}

function makeGroup(id, workspaceId, deletedAt) {
  return {
    id,
    name: `Group ${id}`,
    color: "blue",
    isCompact: false,
    createdAt: "2026-08-23T00:00:00.000Z",
    seq: 0,
    workspaceId,
    ...(deletedAt ? { deletedAt } : {}),
  };
}

function makeSnapshot(options = {}) {
  const seed = createGuestWorkspaceSeed("guest-workspace", "guest-default", 0);
  const workspace = {
    ...seed.workspace,
    ...(options.workspaceName ? { name: options.workspaceName } : {}),
  };
  const sourceDefault = {
    ...seed.collection,
    ...(options.collectionName ? { name: options.collectionName } : {}),
  };
  const extraCollection = {
    id: "guest-extra",
    workspaceId: workspace.id,
    name: "Extra",
    icon: "star",
    position: 2,
    seq: 0,
  };

  return {
    provenance: seed.provenance.value,
    workspace,
    collections: [sourceDefault, ...(options.extraCollection ? [extraCollection] : [])],
    activeBookmarks: options.activeBookmark ? [makeBookmark("active", sourceDefault.id)] : [],
    archivedBookmarks: options.archivedBookmark ? [makeBookmark("archived", sourceDefault.id)] : [],
    trashedBookmarks: options.trashedBookmark ? [makeBookmark("trashed", sourceDefault.id)] : [],
    groups: [
      ...(options.activeGroup ? [makeGroup("active-group", workspace.id)] : []),
      ...(options.trashedGroup ? [makeGroup("trashed-group", workspace.id, 1)] : []),
    ],
    groupTabs: [],
  };
}

function makeTargetWorkspace(id, position) {
  return { id, name: id, color: "blue", position, seq: 4 };
}

function makeTargetCollection(id, workspaceId, position) {
  return {
    id,
    workspaceId,
    name: id,
    icon: "inbox",
    position,
    isDefault: true,
    seq: 4,
  };
}

describe("guest workspace seed", () => {
  test("builds workspace, default collection, and provenance", () => {
    const seed = createGuestWorkspaceSeed("guest-ws", "guest-default", 0);

    expect(seed.workspace).toEqual({
      id: "guest-ws", name: "My Workspace", color: "blue", position: 0, seq: 0,
    });
    expect(seed.collection).toEqual({
      id: "guest-default", workspaceId: "guest-ws", name: "Default",
      icon: "inbox", position: 0, isDefault: true, seq: 0,
    });
    expect(seed.provenance.key).toBe(GUEST_WORKSPACE_PROVENANCE_KEY);
    expect(seed.provenance.value.state).toBe("pending-server-confirmation");
  });
});

describe("guest workspace classification", () => {
  test("recognizes only the untouched automatic seed", () => {
    expect(isUntouchedGuestWorkspace(makeSnapshot())).toBe(true);
    expect(isUntouchedGuestWorkspace(makeSnapshot({ workspaceName: "Renamed" }))).toBe(false);
    expect(isUntouchedGuestWorkspace(makeSnapshot({ collectionName: "Inbox" }))).toBe(false);
    expect(isUntouchedGuestWorkspace(makeSnapshot({ extraCollection: true }))).toBe(false);
    expect(isUntouchedGuestWorkspace(makeSnapshot({ activeBookmark: true }))).toBe(false);
    expect(isUntouchedGuestWorkspace(makeSnapshot({ archivedBookmark: true }))).toBe(false);
    expect(isUntouchedGuestWorkspace(makeSnapshot({ trashedBookmark: true }))).toBe(false);
    expect(isUntouchedGuestWorkspace(makeSnapshot({ activeGroup: true }))).toBe(false);
    expect(isUntouchedGuestWorkspace(makeSnapshot({ trashedGroup: true }))).toBe(false);
  });

  test("treats zero-valued lifecycle timestamps as meaningful changes", () => {
    const deletedWorkspace = makeSnapshot();
    deletedWorkspace.workspace.deletedAt = 0;
    const archivedDefault = makeSnapshot();
    archivedDefault.collections[0].archivedAt = 0;

    expect(isUntouchedGuestWorkspace(deletedWorkspace)).toBe(false);
    expect(isUntouchedGuestWorkspace(archivedDefault)).toBe(false);
  });
});

describe("guest workspace migration planning", () => {
  test("prefers the selected confirmed workspace and otherwise the lowest-position workspace", () => {
    const lowest = makeTargetWorkspace("lowest", 1);
    const selected = makeTargetWorkspace("selected", 9);
    const collections = [
      makeTargetCollection("lowest-default", lowest.id, 0),
      makeTargetCollection("selected-default", selected.id, 0),
    ];

    expect(selectGuestMigrationTarget([selected, lowest], collections, selected.id)?.workspace.id).toBe(selected.id);
    expect(selectGuestMigrationTarget([selected, lowest], collections, "missing")?.workspace.id).toBe(lowest.id);
  });

  test("requires active confirmed workspace and default collection records", () => {
    const deletedWorkspace = { ...makeTargetWorkspace("deleted", 1), deletedAt: 0 };
    const deletedDefault = { ...makeTargetCollection("deleted-default", deletedWorkspace.id, 0), deletedAt: 0 };

    expect(selectGuestMigrationTarget([deletedWorkspace], [deletedDefault], deletedWorkspace.id)).toBeNull();
  });

  test("discards an untouched seed and clears the stale active workspace", () => {
    const targetWorkspace = makeTargetWorkspace("account-workspace", 1);
    const targetDefault = makeTargetCollection("account-default", targetWorkspace.id, 0);
    const target = { workspace: targetWorkspace, defaultCollection: targetDefault };

    expect(planGuestWorkspaceMigration(makeSnapshot(), target)).toEqual({
      kind: "discard",
      workspaceDeletes: ["guest-workspace"],
      collectionDeletes: ["guest-default"],
      activeWorkspaceId: "",
    });
  });

  test("merges an otherwise untouched default and rewrites every bookmark lifecycle bucket", () => {
    const targetWorkspace = makeTargetWorkspace("account-workspace", 1);
    const targetDefault = makeTargetCollection("account-default", targetWorkspace.id, 0);
    const snapshot = makeSnapshot({ activeBookmark: true, archivedBookmark: true, trashedBookmark: true });
    snapshot.collections.push({
      id: "account-second",
      workspaceId: targetWorkspace.id,
      name: "Second",
      icon: "star",
      position: 7,
      seq: 4,
    });

    const plan = planGuestWorkspaceMigration(snapshot, {
      workspace: targetWorkspace,
      defaultCollection: targetDefault,
    });

    expect(plan).toMatchObject({
      kind: "migrate",
      workspaceDeletes: ["guest-workspace"],
      collectionDeletes: ["guest-default"],
      collectionPuts: [],
      bookmarkPuts: {
        active: [{ id: "active", collectionId: "account-default", seq: 0 }],
        archived: [{ id: "archived", collectionId: "account-default", seq: 0 }],
        trashed: [{ id: "trashed", collectionId: "account-default", seq: 0 }],
      },
    });
  });

  test("keeps renamed defaults and ordinary collections in stable target positions", () => {
    const targetWorkspace = makeTargetWorkspace("account-workspace", 1);
    const targetDefault = makeTargetCollection("account-default", targetWorkspace.id, 0);
    const snapshot = makeSnapshot({ collectionName: "Inbox", extraCollection: true });
    snapshot.collections.push({
      id: "account-second",
      workspaceId: targetWorkspace.id,
      name: "Second",
      icon: "star",
      position: 7,
      seq: 4,
    });
    snapshot.groups = [makeGroup("guest-group", "guest-workspace", 1)];

    const plan = planGuestWorkspaceMigration(snapshot, {
      workspace: targetWorkspace,
      defaultCollection: targetDefault,
    });

    expect(plan).toMatchObject({
      kind: "migrate",
      targetWorkspaceId: "account-workspace",
      targetWorkspaceName: "account-workspace",
      collectionDeletes: [],
      collectionPuts: [
        { id: "guest-default", workspaceId: "account-workspace", isDefault: false, position: 8, seq: 0 },
        { id: "guest-extra", workspaceId: "account-workspace", isDefault: false, position: 9, seq: 0 },
      ],
      groupPuts: [{ id: "guest-group", workspaceId: "account-workspace", seq: 0, deletedAt: 1 }],
    });
    expect(plan.collectionPuts).toEqual([
      {
        id: "guest-default",
        workspaceId: "account-workspace",
        name: "Inbox",
        icon: "inbox",
        position: 8,
        isDefault: false,
        seq: 0,
      },
      {
        id: "guest-extra",
        workspaceId: "account-workspace",
        name: "Extra",
        icon: "star",
        position: 9,
        isDefault: false,
        seq: 0,
      },
    ]);
    expect(plan.groupPuts).toEqual([
      {
        id: "guest-group",
        name: "Group guest-group",
        color: "blue",
        isCompact: false,
        createdAt: "2026-08-23T00:00:00.000Z",
        seq: 0,
        workspaceId: "account-workspace",
        deletedAt: 1,
      },
    ]);
  });

  test("returns a conflict without a confirmed target", () => {
    expect(planGuestWorkspaceMigration(makeSnapshot(), null)).toEqual({
      kind: "conflict",
      sourceWorkspaceId: "guest-workspace",
      reason: "no_valid_target",
    });
  });

  test("returns a conflict rather than rewriting a workspace that does not match provenance", () => {
    const targetWorkspace = makeTargetWorkspace("account-workspace", 1);
    const targetDefault = makeTargetCollection("account-default", targetWorkspace.id, 0);
    const snapshot = makeSnapshot({ activeBookmark: true });
    snapshot.workspace = { ...snapshot.workspace, id: "unrelated-workspace" };

    expect(planGuestWorkspaceMigration(snapshot, {
      workspace: targetWorkspace,
      defaultCollection: targetDefault,
    })).toEqual({
      kind: "conflict",
      sourceWorkspaceId: "guest-workspace",
      reason: "no_valid_target",
    });
  });

  test("never flattens a deleted Guest root into a confirmed Workspace", () => {
    const targetWorkspace = makeTargetWorkspace("account-workspace", 1);
    const targetDefault = makeTargetCollection("account-default", targetWorkspace.id, 0);
    const snapshot = makeSnapshot({ activeBookmark: true, activeGroup: true });
    snapshot.workspace.deletedAt = 1234;
    snapshot.workspace.deletionModel = 0;

    expect(planGuestWorkspaceMigration(snapshot, {
      workspace: targetWorkspace,
      defaultCollection: targetDefault,
    })).toEqual({
      kind: "conflict",
      sourceWorkspaceId: "guest-workspace",
      reason: "deleted_root_requires_lifecycle",
    });
  });
});
