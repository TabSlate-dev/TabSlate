import type { StateStorage } from "zustand/middleware";
import type { SyncPushEntities } from "@/lib/api";
import type { BulkWriteOp } from "@/lib/idb";
import { importFresh, type ModuleReplacer } from "./module-replacer";

export interface RecordedWrite {
  type: "put" | "delete";
  store: string;
  key: string;
}

export interface BookmarksStoreHarness {
  useBookmarksStore: typeof import("@/store/bookmarks-store").useBookmarksStore;
  usePlanStore: typeof import("@/store/plan-store").usePlanStore;
  /** Payloads handed to syncEngine.enqueue, oldest first. */
  enqueued: Array<Partial<SyncPushEntities>>;
  /** The operations of each idbBulkWrite call, oldest first. */
  bulkWrites: BulkWriteOp[][];
  /** idbPut and idbDelete calls, oldest first. */
  writes: RecordedWrite[];
  /** What the fake IndexedDB returns from reads: store name, then key. */
  records: Map<string, Map<string, object>>;
  /** Clears the recordings and records, and empties the store with every bucket loaded. */
  reset: () => void;
}

function createMemoryStorage(): StateStorage {
  const items = new Map<string, string>();
  return {
    getItem: async (name) => items.get(name) ?? null,
    setItem: async (name, value) => {
      items.set(name, value);
    },
    removeItem: async (name) => {
      items.delete(name);
    },
  };
}

function recordKey(value: object): string {
  const id = Reflect.get(value, "id");
  return typeof id === "string" ? id : String(Reflect.get(value, "key"));
}

/**
 * Loads a fresh bookmarks store whose IndexedDB and sync engine are fakes that
 * record every write, so tests can count transactions and enqueues.
 */
export async function installBookmarksStoreHarness(replacer: ModuleReplacer): Promise<BookmarksStoreHarness> {
  const enqueued: Array<Partial<SyncPushEntities>> = [];
  const bulkWrites: BulkWriteOp[][] = [];
  const writes: RecordedWrite[] = [];
  const records = new Map<string, Map<string, object>>();
  const storeRecords = (store: string): Map<string, object> => records.get(store) ?? new Map<string, object>();

  const realIdb = await importFresh<typeof import("@/lib/idb")>("lib/idb.ts");
  await replacer.replace("@/lib/idb", {
    ...realIdb,
    idbGet: async (store: string, key: IDBValidKey) => storeRecords(store).get(String(key)),
    idbGetAll: async (store: string) => [...storeRecords(store).values()],
    idbGetByIndex: async (store: string, index: string, value: IDBValidKey) =>
      [...storeRecords(store).values()].filter((record) => Reflect.get(record, index) === value),
    idbGetMany: async (store: string, keys: IDBValidKey[]) => keys.map((key) => storeRecords(store).get(String(key))),
    idbPut: async (store: string, value: object) => {
      writes.push({ type: "put", store, key: recordKey(value) });
    },
    idbDelete: async (store: string, key: IDBValidKey) => {
      writes.push({ type: "delete", store, key: String(key) });
    },
    idbBulkWrite: async (ops: BulkWriteOp[]) => {
      bulkWrites.push(ops);
    },
  });
  // The conflict registry starts reading IndexedDB when its module loads. A copy
  // another test file loaded may still wait on the inert IndexedDB stub forever.
  await replacer.replace(
    "@/lib/sync-conflicts",
    await importFresh<typeof import("@/lib/sync-conflicts")>("lib/sync-conflicts.ts"),
  );
  const realStorage = await importFresh<typeof import("@/lib/chrome-storage-adapter")>("lib/chrome-storage-adapter.ts");
  await replacer.replace("@/lib/chrome-storage-adapter", { ...realStorage, chromeStorageAdapter: createMemoryStorage() });
  const planStore = await importFresh<typeof import("@/store/plan-store")>("store/plan-store.ts");
  await replacer.replace("@/store/plan-store", planStore);
  const realSyncEngine = await importFresh<typeof import("@/lib/sync-engine")>("lib/sync-engine.ts");
  await replacer.replace("@/lib/sync-engine", {
    ...realSyncEngine,
    syncEngine: {
      enqueue: (entities: Partial<SyncPushEntities>) => {
        enqueued.push(entities);
      },
      forcePush: async () => {},
    },
  });
  const bookmarksStore = await importFresh<typeof import("@/store/bookmarks-store")>("store/bookmarks-store.ts");
  await replacer.replace("@/store/bookmarks-store", bookmarksStore);

  const { useBookmarksStore } = bookmarksStore;
  const { usePlanStore } = planStore;
  return {
    useBookmarksStore,
    usePlanStore,
    enqueued,
    bulkWrites,
    writes,
    records,
    reset: () => {
      enqueued.length = 0;
      bulkWrites.length = 0;
      writes.length = 0;
      records.clear();
      // A fresh fetch time keeps ensureFresh() from reaching for the network.
      usePlanStore.setState({ limits: null, usage: null, fetchedAt: Date.now() });
      useBookmarksStore.setState({
        bookmarks: new Map(),
        countsByCollection: {},
        archivedBookmarks: [],
        trashedBookmarks: [],
        _archivedLoaded: true,
        _trashedLoaded: true,
        selectedCollection: "all",
        selectedTags: [],
        searchQuery: "",
        filterType: "all",
        sortBy: "date-newest",
      });
    },
  };
}
