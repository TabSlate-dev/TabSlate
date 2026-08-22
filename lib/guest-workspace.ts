import type { Bookmark, Collection, Workspace } from "@/lib/types";
import type { GroupTab, SavedGroup } from "@/store/groups-store";

export const GUEST_WORKSPACE_PROVENANCE_KEY = "guest-workspace-provenance-v1";

export interface GuestWorkspaceFingerprint {
  workspaceName: string;
  workspaceColor: string;
  workspacePosition: number;
  collectionName: string;
  collectionIcon: string;
  collectionPosition: number;
}

export interface GuestWorkspaceProvenanceValue {
  version: 1;
  state: "pending-server-confirmation";
  workspaceId: string;
  defaultCollectionId: string;
  fingerprint: GuestWorkspaceFingerprint;
}

export interface GuestWorkspaceProvenanceRecord {
  key: typeof GUEST_WORKSPACE_PROVENANCE_KEY;
  value: GuestWorkspaceProvenanceValue;
}

export interface GuestWorkspaceSeed {
  workspace: Workspace;
  collection: Collection;
  provenance: GuestWorkspaceProvenanceRecord;
}

export interface GuestWorkspaceSnapshot {
  provenance: GuestWorkspaceProvenanceValue;
  workspace?: Workspace;
  collections: Collection[];
  activeBookmarks: Bookmark[];
  archivedBookmarks: Bookmark[];
  trashedBookmarks: Bookmark[];
  groups: SavedGroup[];
  groupTabs: GroupTab[];
}

export function createGuestWorkspaceSeed(
  workspaceId: string,
  collectionId: string,
  position: number,
): GuestWorkspaceSeed {
  const workspace: Workspace = {
    id: workspaceId, name: "My Workspace", color: "blue", position, seq: 0,
  };
  const collection: Collection = {
    id: collectionId, workspaceId, name: "Default", icon: "inbox",
    position: 0, isDefault: true, seq: 0,
  };
  return {
    workspace,
    collection,
    provenance: {
      key: GUEST_WORKSPACE_PROVENANCE_KEY,
      value: {
        version: 1,
        state: "pending-server-confirmation",
        workspaceId,
        defaultCollectionId: collectionId,
        fingerprint: {
          workspaceName: workspace.name,
          workspaceColor: workspace.color,
          workspacePosition: workspace.position,
          collectionName: collection.name,
          collectionIcon: collection.icon,
          collectionPosition: collection.position,
        },
      },
    },
  };
}
