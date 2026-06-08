import { beforeEach, describe, expect, mock, test } from "bun:test";

const fetchCalls = [];

beforeEach(() => {
  fetchCalls.length = 0;
  process.env.VITE_OPENADS_API_URL = "https://ads.example.test/api";
  process.env.VITE_OPENADS_HOMEPAGE_TIER_ID = "homepage-tier";
  process.env.VITE_OPENADS_SIDEBAR_TIER_ID = "sidebar-tier";
});

describe("ads-store", () => {
  test("fetchAds clears fetchedAt when response JSON parsing fails", async () => {
    globalThis.fetch = mock(async (url) => {
      fetchCalls.push(url);
      return {
        ok: true,
        json: async () => {
          throw new Error("invalid json");
        },
      };
    });

    const { useAdsStore } = await import("../store/ads-store");

    useAdsStore.setState({
      ads: [],
      homepageAds: [],
      sidebarAds: [],
      isFetching: false,
      fetchedAt: 123,
    });

    await useAdsStore.getState().fetchAds();

    expect(fetchCalls).toEqual(["https://ads.example.test/api"]);
    expect(useAdsStore.getState().isFetching).toBe(false);
    expect(useAdsStore.getState().fetchedAt).toBeNull();
  });

  test("fetchAds clears fetchedAt when fetch rejects", async () => {
    globalThis.fetch = mock(async (url) => {
      fetchCalls.push(url);
      throw new Error("network down");
    });

    const { useAdsStore } = await import("../store/ads-store");

    useAdsStore.setState({
      ads: [],
      homepageAds: [],
      sidebarAds: [],
      isFetching: false,
      fetchedAt: 456,
    });

    await useAdsStore.getState().fetchAds();

    expect(fetchCalls).toEqual(["https://ads.example.test/api"]);
    expect(useAdsStore.getState().isFetching).toBe(false);
    expect(useAdsStore.getState().fetchedAt).toBeNull();
  });
});
