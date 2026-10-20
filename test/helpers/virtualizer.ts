import { importFresh, type ModuleReplacer } from "./module-replacer";

/**
 * happy-dom has no layout, so @tanstack/react-virtual would render no rows.
 * This makes every scroll element measure 1200×2000 and records scroll requests.
 */
export async function installMeasuredVirtualizer(replacer: ModuleReplacer, scrollOffsets: number[] = []): Promise<void> {
  const virtual = await import("@tanstack/react-virtual");
  const useRealVirtualizer = virtual.useVirtualizer;
  await replacer.replace("@tanstack/react-virtual", {
    ...virtual,
    useVirtualizer: (options: Parameters<typeof virtual.useVirtualizer>[0]) => useRealVirtualizer({
      ...options,
      initialRect: { width: 1200, height: 2000 },
      observeElementRect: (_instance, callback) => {
        callback({ width: 1200, height: 2000 });
        return () => {};
      },
      scrollToFn: (offset) => {
        scrollOffsets.push(offset);
      },
    }),
  });
}

/** BookmarksContent loads open tabs when it mounts; tests have no tabs API. */
export async function installQuietTabsStore(replacer: ModuleReplacer): Promise<void> {
  const tabs = await importFresh<typeof import("@/store/tabs-store")>("store/tabs-store.ts");
  tabs.useTabsStore.setState({ loadTabs: async () => {} });
  await replacer.replace("@/store/tabs-store", tabs);
}
