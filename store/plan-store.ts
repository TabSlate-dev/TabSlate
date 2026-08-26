import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { chromeStorageAdapter } from "@/lib/chrome-storage-adapter";
import { api, type PlanLimits, type PlanResponse, type PlanUsage } from "@/lib/api";
import { useAuthStore } from "@/store/auth-store";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { notifyPlanRefreshObservers } from "@/lib/plan-refresh-observer";
import {
  createQuotaBreakdown,
  createZeroPlanUsage,
  type QuotaUsageBreakdown,
} from "@/lib/quota-usage";

export type QuotaResource = "bookmark" | "collection" | "tag" | "workspace" | "saved_group";

interface QuotaAlert {
  resource: QuotaResource;
  limit: number;
}

interface PlanState {
  subscription: { plan: string; status: string; expires_at: number | null } | null;
  limits: PlanLimits | null;
  usage: PlanUsage | null;
  trashUsage: PlanUsage | null;
  inUseUsage: PlanUsage | null;
  fetchedAt: number | null;
  isFetching: boolean;
  quotaAlert: QuotaAlert | null;

  fetchPlan: () => Promise<PlanResponse | null>;
  ensureFresh: (force?: boolean) => void;
  checkQuota: (resource: QuotaResource, currentCount?: number) => boolean;
  incrementUsage: (resource: QuotaResource, by?: number) => void;
  decrementUsage: (resource: QuotaResource, by?: number) => void;
  moveUsageToTrash: (resource: QuotaResource, by?: number) => void;
  restoreUsageFromTrash: (resource: QuotaResource, by?: number) => void;
  setGuestUsage: (breakdown: QuotaUsageBreakdown) => void;
  showQuotaAlert: (resource: QuotaResource) => void;
  invalidatePendingFetch: () => void;
  clear: () => void;
}

const TTL_MS = 5 * 60 * 1000;

const LIMIT_KEY: Record<QuotaResource, keyof PlanLimits> = {
  bookmark:    "max_bookmarks",
  collection:  "max_collections",
  tag:         "max_tags",
  workspace:   "max_workspaces",
  saved_group: "max_saved_groups",
};

const USAGE_KEY: Record<QuotaResource, keyof PlanUsage> = {
  bookmark:    "bookmarks",
  collection:  "collections",
  tag:         "tags",
  workspace:   "workspaces",
  saved_group: "saved_groups",
};

let _alertTimer: ReturnType<typeof setTimeout> | null = null;
let _planRequestGeneration = 0;

interface InFlightPlanRequest {
  serverUrl: string;
  accessToken: string;
  generation: number;
  promise: Promise<PlanResponse | null>;
}

let _inFlightPlanRequest: InFlightPlanRequest | null = null;

function hasCurrentAuthCredentials(serverUrl: string, accessToken: string): boolean {
  const currentAuth = useAuthStore.getState();
  return currentAuth.serverUrl === serverUrl && currentAuth.accessToken === accessToken;
}

export const usePlanStore = create<PlanState>()(
  persist(
    (set, get) => ({
      subscription: null,
      limits: null,
      usage: null,
      trashUsage: null,
      inUseUsage: null,
      fetchedAt: null,
      isFetching: false,
      quotaAlert: null,

      fetchPlan: async () => {
        const { serverUrl, accessToken } = useAuthStore.getState();
        if (!serverUrl || !accessToken) { return null; }
        const requestGeneration = _planRequestGeneration;
        if (
          _inFlightPlanRequest &&
          _inFlightPlanRequest.serverUrl === serverUrl &&
          _inFlightPlanRequest.accessToken === accessToken &&
          _inFlightPlanRequest.generation === requestGeneration
        ) {
          return _inFlightPlanRequest.promise;
        }

        set({ isFetching: true });
        let inFlightRequest: InFlightPlanRequest | null = null;
        const request = (async (): Promise<PlanResponse | null> => {
          try {
            const data = await api.getPlan(serverUrl, accessToken);
            if (
              requestGeneration !== _planRequestGeneration ||
              !hasCurrentAuthCredentials(serverUrl, accessToken)
            ) {
              if (_inFlightPlanRequest === inFlightRequest) {
                set({ isFetching: false });
              }
              return null;
            }
            const breakdown = createQuotaBreakdown(
              data.usage,
              data.trash_usage ?? createZeroPlanUsage(),
            );
            set({
              subscription: data.subscription,
              limits: data.limits,
              usage: breakdown.total,
              trashUsage: breakdown.trash,
              inUseUsage: breakdown.inUse,
              fetchedAt: Date.now(),
              isFetching: false,
            });
            await notifyPlanRefreshObservers(data);
            // Prune expired trash entries now that we have an authoritative grace period.
            const bmStore = useBookmarksStore.getState();
            if (bmStore._trashedLoaded && data.limits.trash_grace_days > 0) {
              bmStore.pruneExpiredTrash(data.limits.trash_grace_days);
            }
            return data;
          } catch {
            if (
              requestGeneration === _planRequestGeneration &&
              hasCurrentAuthCredentials(serverUrl, accessToken) &&
              _inFlightPlanRequest === inFlightRequest
            ) {
              set({ isFetching: false });
            }
            return null;
          }
        })();
        inFlightRequest = {
          serverUrl,
          accessToken,
          generation: requestGeneration,
          promise: request,
        };
        _inFlightPlanRequest = inFlightRequest;
        try {
          return await request;
        } finally {
          if (_inFlightPlanRequest === inFlightRequest) {
            _inFlightPlanRequest = null;
          }
        }
      },

      ensureFresh: (force = false) => {
        const { fetchedAt, isFetching } = get();
        if (isFetching) { return; }
        if (!force && fetchedAt !== null && Date.now() - fetchedAt < TTL_MS) { return; }
        void get().fetchPlan();
      },

      checkQuota: (resource, currentCount) => {
        const { limits } = get();
        if (!limits) { return true; }
        const max = limits[LIMIT_KEY[resource]];
        if (max === -1) { return true; }
        // Prefer caller-supplied local count (always accurate even if fetchPlan
        // returned a stale server value that doesn't reflect unsynced deletes).
        if (currentCount !== undefined) { return currentCount < max; }
        const { usage } = get();
        if (!usage) { return true; }
        return usage[USAGE_KEY[resource]] < max;
      },

      incrementUsage: (resource, by = 1) => {
        set((s) => {
          if (!s.usage) { return {}; }
          const key = USAGE_KEY[resource];
          const total = { ...s.usage, [key]: s.usage[key] + by };
          const breakdown = createQuotaBreakdown(
            total,
            s.trashUsage ?? createZeroPlanUsage(),
          );
          return {
            usage: breakdown.total,
            trashUsage: breakdown.trash,
            inUseUsage: breakdown.inUse,
          };
        });
      },

      decrementUsage: (resource, by = 1) => {
        set((s) => {
          if (!s.usage) { return {}; }
          const key = USAGE_KEY[resource];
          const total = { ...s.usage, [key]: Math.max(0, s.usage[key] - by) };
          const currentTrash = s.trashUsage ?? createZeroPlanUsage();
          const trash = {
            ...currentTrash,
            [key]: Math.max(0, currentTrash[key] - by),
          };
          const breakdown = createQuotaBreakdown(
            total,
            trash,
          );
          return {
            usage: breakdown.total,
            trashUsage: breakdown.trash,
            inUseUsage: breakdown.inUse,
          };
        });
      },

      moveUsageToTrash: (resource, by = 1) => {
        set((state) => {
          if (!state.usage) { return {}; }
          const key = USAGE_KEY[resource];
          const currentTrash = state.trashUsage ?? createZeroPlanUsage();
          const breakdown = createQuotaBreakdown(state.usage, {
            ...currentTrash,
            [key]: currentTrash[key] + by,
          });
          return {
            usage: breakdown.total,
            trashUsage: breakdown.trash,
            inUseUsage: breakdown.inUse,
          };
        });
      },

      restoreUsageFromTrash: (resource, by = 1) => {
        set((state) => {
          if (!state.usage) { return {}; }
          const key = USAGE_KEY[resource];
          const currentTrash = state.trashUsage ?? createZeroPlanUsage();
          const breakdown = createQuotaBreakdown(state.usage, {
            ...currentTrash,
            [key]: Math.max(0, currentTrash[key] - by),
          });
          return {
            usage: breakdown.total,
            trashUsage: breakdown.trash,
            inUseUsage: breakdown.inUse,
          };
        });
      },

      setGuestUsage: (breakdown) => {
        set({
          usage: breakdown.total,
          trashUsage: breakdown.trash,
          inUseUsage: breakdown.inUse,
        });
      },

      showQuotaAlert: (resource) => {
        if (_alertTimer !== null) { clearTimeout(_alertTimer); }
        const limits = get().limits;
        const limit = limits ? limits[LIMIT_KEY[resource]] : 0;
        set({ quotaAlert: { resource, limit } });
        _alertTimer = setTimeout(() => {
          set({ quotaAlert: null });
          _alertTimer = null;
        }, 3000);
      },

      // Bumps the request generation without clearing displayed state, so a
      // still-in-flight fetchPlan (started before a mutation this caller
      // just confirmed, e.g. workspace-manager's ensurePlanFresh() on open)
      // can no longer be reused by a subsequent fetchPlan() call — that call
      // will see requestGeneration !== _planRequestGeneration and issue a
      // fresh request instead of returning a response computed before the
      // mutation.
      invalidatePendingFetch: () => {
        _planRequestGeneration += 1;
      },

      clear: () => {
        _planRequestGeneration += 1;
        if (_alertTimer !== null) { clearTimeout(_alertTimer); _alertTimer = null; }
        set({
          subscription: null,
          limits: null,
          usage: null,
          trashUsage: null,
          inUseUsage: null,
          fetchedAt: null,
          isFetching: false,
          quotaAlert: null,
        });
      },
    }),
    {
      name: "tabslate-plan",
      storage: createJSONStorage(() => chromeStorageAdapter),
      partialize: (state) => ({
        subscription: state.subscription,
        limits: state.limits,
        usage: state.usage,
        trashUsage: state.trashUsage,
        inUseUsage: state.inUseUsage,
        fetchedAt: state.fetchedAt,
      }),
    },
  ),
);

/**
 * Standard quota gate for create actions. Calls ensureFresh, checks quota,
 * shows alert on breach, and returns the provided fallback. Returns
 * action() otherwise.
 */
export function guardQuota<T>(
  resource: QuotaResource,
  currentCount: number | undefined,
  fallback: T,
  action: () => T,
): T {
  const store = usePlanStore.getState();
  store.ensureFresh();
  if (!store.checkQuota(resource, currentCount)) {
    store.showQuotaAlert(resource);
    return fallback;
  }
  return action();
}
