import { create } from "zustand";

export interface RawAdMeta {
  fieldId: string;
  fieldName: string;
  value: string;
}

export interface RawAd {
  id: string;
  name: string;
  websiteUrl: string;
  weight: number;
  tier?: {
    id: string;
    name: string;
  };
  meta: RawAdMeta[];
}

export interface Ad {
  id: string;
  title: string;
  description: string;
  badge: string;
  action: string;
  websiteUrl: string;
  weight: number;
  tierId?: string;
  iconUrl?: string;
  gradient: string;
  iconColor: string;
}

interface AdsState {
  ads: Ad[];
  homepageAds: Ad[];
  sidebarAds: Ad[];
  isFetching: boolean;
  fetchedAt: number | null;
  fetchAds: () => Promise<void>;
  ensureFresh: () => void;
}

const GRADIENTS = [
  { gradient: "from-primary/20 to-purple-500/20", iconColor: "text-primary/80" },
  { gradient: "from-blue-500/20 to-cyan-500/20", iconColor: "text-blue-500/80" },
  { gradient: "from-emerald-500/20 to-teal-500/20", iconColor: "text-emerald-500/80" },
  { gradient: "from-rose-500/20 to-orange-500/20", iconColor: "text-rose-500/80" },
  { gradient: "from-amber-500/20 to-yellow-500/20", iconColor: "text-amber-500/80" },
  { gradient: "from-indigo-500/20 to-blue-500/20", iconColor: "text-indigo-500/80" },
];

export function mapRawAd(raw: RawAd, index: number): Ad {
  const metaMap = new Map(raw.meta.map((m) => [m.fieldName.toLowerCase().trim(), m.value]));
  const style = GRADIENTS[index % GRADIENTS.length];

  return {
    id: raw.id,
    title: raw.name,
    description: metaMap.get("description") || "",
    badge: metaMap.get("badge") || "AD",
    action: metaMap.get("action") || "Learn More",
    websiteUrl: raw.websiteUrl,
    weight: raw.weight ?? 1,
    tierId: raw.tier?.id,
    iconUrl: metaMap.get("icon url"),
    gradient: style.gradient,
    iconColor: style.iconColor,
  };
}

const TTL_MS = 10 * 60 * 1000; // 10 minutes cache TTL

export const useAdsStore = create<AdsState>()((set, get) => ({
  ads: [],
  homepageAds: [],
  sidebarAds: [],
  isFetching: false,
  fetchedAt: null,

  fetchAds: async () => {
    if (get().isFetching) { return; }
    set({ isFetching: true });
    try {
      const apiUrl = import.meta.env.VITE_OPENADS_API_URL;
      if (!apiUrl) {
        console.warn("VITE_OPENADS_API_URL is not configured in .env.local");
        set({ isFetching: false });
        return;
      }
      const response = await fetch(apiUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch ads: ${response.status}`);
      }
      const data = await response.json();
      const rawAds: RawAd[] = data?.result?.data?.json ?? [];

      // Map raw ads and sort by weight in descending order
      const mappedAds = rawAds
        .map((raw, idx) => mapRawAd(raw, idx))
        .sort((a, b) => b.weight - a.weight);

      const homepageTierId = import.meta.env.VITE_OPENADS_HOMEPAGE_TIER_ID;
      const sidebarTierId = import.meta.env.VITE_OPENADS_SIDEBAR_TIER_ID;

      const homepageAds = mappedAds.filter((ad) => ad.tierId === homepageTierId);
      const sidebarAds = mappedAds.filter((ad) => ad.tierId === sidebarTierId);

      set({
        ads: mappedAds,
        homepageAds,
        sidebarAds,
        fetchedAt: Date.now(),
        isFetching: false,
      });
    } catch (err) {
      console.error("Error fetching ads:", err);
      set({ isFetching: false });
    }
  },

  ensureFresh: () => {
    const { fetchedAt, isFetching } = get();
    if (isFetching) { return; }
    if (fetchedAt !== null && Date.now() - fetchedAt < TTL_MS) { return; }
    void get().fetchAds();
  },
}));
