import { api } from "@/lib/api";
import { SyncQueue, type SyncPushFailure } from "@/lib/sync-queue";
import { SSEClient } from "@/lib/sse-client";
import { useAuthStore } from "@/store/auth-store";
import {
  SyncEngine,
  type OnLegacyPushFailure,
  type OnPullSuccess,
  type OnPushSuccess,
  type SyncStatus,
} from "@/lib/sync-engine";

type Credentials = { baseUrl: string; accessToken: string };
type GetCredentials = () => Credentials | null;
type GetLocalSeq = () => number;
type OnStatusChange = (status: SyncStatus, errorMessage?: string) => void;

export function createSyncEngine(
  getCredentials: GetCredentials,
  getLocalSeq: GetLocalSeq,
  onPullSuccess: OnPullSuccess,
  onPushSuccess: OnPushSuccess,
  onStatusChange: OnStatusChange,
  onLegacyPushFailure: OnLegacyPushFailure,
): SyncEngine {
  return new SyncEngine(
    getCredentials,
    getLocalSeq,
    onPullSuccess,
    onPushSuccess,
    onStatusChange,
    onLegacyPushFailure,
    {
      createQueue: (credentials, onSuccess, onFailure) => new SyncQueue(credentials, onSuccess, onFailure),
      createSseClient: (credentials, onSequence, onStatusChange) =>
        new SSEClient(credentials, onSequence, onStatusChange),
      syncPull: (baseUrl, accessToken, localSeq) => api.syncPull(baseUrl, accessToken, localSeq),
      refreshAuthentication: (options) => useAuthStore.getState().silentRefresh(options),
      hasRefreshToken: () => Boolean(useAuthStore.getState().refreshToken),
    },
  );
}
