import { describe, expect, test } from "bun:test";
import {
  GUEST_WORKSPACE_PROVENANCE_KEY,
  createGuestWorkspaceSeed,
} from "../lib/guest-workspace";

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
