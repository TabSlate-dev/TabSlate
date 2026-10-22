import type { SyncPushPayload, SyncPushResponse, SyncPullResponse, SyncRejected } from "@/lib/api";
import type { Tag } from "@/lib/types";

export function isTagParentRejection(rejection: SyncRejected): boolean {
  return rejection.type === "tag" && rejection.reason === "invalid_field" && rejection.field === "parent_id";
}

export function isTagDeletionRejection(rejection: SyncRejected, attempted: SyncPushPayload): boolean {
  return rejection.type === "tag" && rejection.reason === "invalid_state" &&
    attempted.entities.tags.some(tag => tag.id === rejection.id && typeof tag.deleted_at === "number");
}

/** The caller must supply a full authoritative pull, never a delta or a rejection alone. */
export async function reconcileRejectedTagParents(
  response: SyncPushResponse,
  attempted: SyncPushPayload,
  authoritative: SyncPullResponse,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent()) { return; }
  const { useWorkspaceStore } = await import("@/store/workspace-store");
  if (!isCurrent()) { return; }
  for (const rejection of response.rejected) {
    if (!isCurrent()) { return; }
    const sent = attempted.entities.tags.find(tag => tag.id === rejection.id);
    if (!sent) { continue; }
    const server = authoritative.entities.tags.find(tag => tag.id === rejection.id);
    if (isTagParentRejection(rejection)) {
      const local = useWorkspaceStore.getState().tags.find(tag => tag.id === rejection.id);
      const tag: Tag | undefined = server ? {
        id: server.id,
        name: server.name,
        color: server.color ?? "gray",
        parentId: server.parent_id === undefined ? local?.parentId : server.parent_id || undefined,
        seq: server.seq,
        deletedAt: server.deleted_at,
      } : undefined;
      await useWorkspaceStore.getState().restoreRejectedTagParent(rejection.id, sent, tag, isCurrent);
    } else if (isTagDeletionRejection(rejection, attempted) && (!server || server.deleted_at != null)) {
      await useWorkspaceStore.getState().settleRejectedTagDeletion(rejection.id, sent, isCurrent);
    }
  }
}
