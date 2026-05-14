import { create } from "zustand";
import { api, type PlanLimits, type PlanUsage } from "@/lib/api";
import { useAuthStore } from "@/store/auth-store";

export type QuotaResource = "bookmark" | "collection" | "tag" | "workspace" | "saved_group";

interface QuotaAlert {
  resource: QuotaResource;
  limit: number;
}

interface PlanState {
  subscription: { plan: string; status: string; expires_at: number | null } | null;
  limits: PlanLimits | null;
  usage: PlanUsage | null;
  fetchedAt: number | null;
  isFetching: boolean;
  quotaAlert: QuotaAlert | null;

  fetchPlan: () => Promise<void>;
  ensureFresh: () => void;
  checkQuota: (resource: QuotaResource) => boolean;
  incrementUsage: (resource: QuotaResource, by?: number) => void;
  decrementUsage: (resource: QuotaResource, by?: number) => void;
  showQuotaAlert: (resource: QuotaResource) => void;
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

export const usePlanStore = create<PlanState>((set, get) => ({
  subscription: null,
  limits: null,
  usage: null,
  fetchedAt: null,
  isFetching: false,
  quotaAlert: null,

  fetchPlan: async () => {
    const { serverUrl, accessToken } = useAuthStore.getState();
    if (!serverUrl || !accessToken) { return; }
    if (get().isFetching) { return; }
    set({ isFetching: true });
    try {
      const data = await api.getPlan(serverUrl, accessToken);
      set({
        subscription: data.subscription,
        limits: data.limits,
        usage: data.usage,
        fetchedAt: Date.now(),
        isFetching: false,
      });
    } catch {
      set({ isFetching: false });
    }
  },

  ensureFresh: () => {
    const { fetchedAt, isFetching } = get();
    if (isFetching) { return; }
    if (fetchedAt !== null && Date.now() - fetchedAt < TTL_MS) { return; }
    void get().fetchPlan();
  },

  checkQuota: (resource) => {
    const { limits, usage } = get();
    if (!limits || !usage) { return true; }
    const max = limits[LIMIT_KEY[resource]];
    if (max === -1) { return true; }
    return usage[USAGE_KEY[resource]] < max;
  },

  incrementUsage: (resource, by = 1) => {
    set((s) => {
      if (!s.usage) { return {}; }
      const key = USAGE_KEY[resource];
      return { usage: { ...s.usage, [key]: s.usage[key] + by } };
    });
  },

  decrementUsage: (resource, by = 1) => {
    set((s) => {
      if (!s.usage) { return {}; }
      const key = USAGE_KEY[resource];
      return { usage: { ...s.usage, [key]: Math.max(0, s.usage[key] - by) } };
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

  clear: () => {
    if (_alertTimer !== null) { clearTimeout(_alertTimer); _alertTimer = null; }
    set({
      subscription: null,
      limits: null,
      usage: null,
      fetchedAt: null,
      isFetching: false,
      quotaAlert: null,
    });
  },
}));
