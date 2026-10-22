// @ts-expect-error Bun provides this test module at runtime.
import { mock } from "bun:test";
import type { Tag } from "@/lib/types";

/** A transactional IDB boundary: writes become visible only at commit; abort discards them. */
export function createTagIdb() {
  const tables = new Map<string, Map<string, object>>();
  const state = { transactions: 0, fail: false, failReads: false, beforeRead: undefined as (() => void) | undefined };
  const table = (name: string) => {
    let records = tables.get(name);
    if (!records) {
      records = new Map();
      tables.set(name, records);
    }
    return records;
  };
  const read = <T>(name: string): T[] => structuredClone([...table(name).values()]) as T[];
  const seed = (tags: Tag[]) => { tables.set("tags", new Map(tags.map(tag => [tag.id, structuredClone(tag)]))); };
  const idbTransaction = async <T>(_stores: string[], _mode: string, callback: (transaction: IDBTransaction) => T): Promise<T> => {
    state.transactions += 1;
    if (state.fail) { throw new Error("disk full"); }
    const pending: (() => void)[] = [];
    const requests: (() => void)[] = [];
    let aborted = false;
    const transaction = {
      abort: () => { aborted = true; },
      objectStore: (name: string) => ({
        getAll: () => {
          const request = { result: undefined as object[] | undefined, onsuccess: undefined as (() => void) | undefined, onerror: null };
          requests.push(() => { request.result = read(name); request.onsuccess?.(); });
          return request;
        },
        get: (id: string) => {
          const request = { result: undefined as object | undefined, onsuccess: undefined as (() => void) | undefined, onerror: null };
          requests.push(() => { request.result = structuredClone(table(name).get(id)); request.onsuccess?.(); });
          return request;
        },
        put: (record: { id?: string; key?: string }) => { pending.push(() => table(name).set(record.id ?? record.key ?? "", structuredClone(record))); },
        delete: (id: string) => { pending.push(() => table(name).delete(id)); },
      }),
    };
    const result = callback(transaction as unknown as IDBTransaction);
    await Promise.resolve();
    state.beforeRead?.();
    state.beforeRead = undefined;
    for (const request of requests) { if (!aborted) { request(); } }
    if (aborted) { throw new Error("transaction aborted"); }
    for (const write of pending) { write(); }
    return result;
  };
  const module = {
    idbTransaction,
    idbTryAcquireLock: async () => true,
    idbRenewLock: async () => true,
    idbReleaseLock: async () => {},
    idbGetAll: async <T>(name: string) => {
      if (state.failReads) { throw new Error("read failed"); }
      return read<T>(name);
    },
    idbGet: async (name: string, id: string) => structuredClone(table(name).get(id)),
    idbPut: async (name: string, value: { id?: string; key?: string }) => { table(name).set(value.id ?? value.key ?? "", structuredClone(value)); },
    idbDelete: async (name: string, id: string) => { table(name).delete(id); },
    idbBulkWrite: async (ops: { type: string; store: string; key: string; value: { id: string } }[]) => {
      for (const op of ops) {
        if (op.type === "delete") { table(op.store).delete(op.key); } else { table(op.store).set(op.value.id, structuredClone(op.value)); }
      }
    },
  };
  return { state, read, seed, tables, module };
}

export function installTagIdb() {
  const db = createTagIdb();
  mock.module("@/lib/idb", () => db.module);
  return db;
}
