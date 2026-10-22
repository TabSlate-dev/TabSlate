import * as idb from "@/lib/idb";
import type { TagMutationPlan } from "@/lib/tag-mutations";
import type { Tag } from "@/lib/types";

export class TagMutationStaleError extends Error {
  constructor() {
    super("Tag records changed before the mutation committed");
    this.name = "TagMutationStaleError";
  }
}

let generation = 0;
let tail: Promise<void> = Promise.resolve();
const transactions = new Set<IDBTransaction>();

export function tagMutationSession(): () => boolean {
  const captured = generation;
  return () => captured === generation;
}

export function invalidateTagMutations(): void {
  generation += 1;
  for (const transaction of transactions) {
    try { transaction.abort(); } catch { /* Already committed. */ }
  }
}

/** Serialize actions and pulls in this JS context; IDB provides cross-context isolation. */
export function serializeTagMutation<T>(action: () => Promise<T>): Promise<T> {
  const result = tail.then(action);
  tail = result.then(() => {}, () => {});
  return result;
}

export interface TagRecordChanges {
  puts: Tag[];
  deletes: string[];
}

/** Decide from the durable records and write in the same transaction. */
export async function changePersistedTags(
  decide: (records: Tag[]) => TagRecordChanges,
  isCurrent: () => boolean = tagMutationSession(),
): Promise<void> {
  let failure: Error | undefined;
  let activeTransaction: IDBTransaction | undefined;
  try {
    await idb.idbTransaction(["tags"], "readwrite", (transaction) => {
      activeTransaction = transaction;
      transactions.add(transaction);
      const request: IDBRequest<Tag[]> = transaction.objectStore("tags").getAll();
      request.onerror = () => transaction.abort();
      request.onsuccess = () => {
        try {
          if (!isCurrent()) { throw new TagMutationStaleError(); }
          const changes = decide(request.result);
          for (const tag of changes.puts) { transaction.objectStore("tags").put(tag); }
          for (const id of changes.deletes) { transaction.objectStore("tags").delete(id); }
        } catch (error) {
          failure = error instanceof Error ? error : new Error("Tag mutation failed");
          transaction.abort();
        }
      };
    });
  } catch (error) {
    if (!isCurrent()) { throw new TagMutationStaleError(); }
    throw failure ?? error;
  } finally {
    if (activeTransaction) { transactions.delete(activeTransaction); }
  }
}

export function tagRecordsEqual(left: Tag, right: Tag): boolean {
  return left.id === right.id && left.name === right.name && left.color === right.color &&
    left.parentId === right.parentId && left.seq === right.seq && left.deletedAt === right.deletedAt;
}

export function commitTagMutation(
  plan: TagMutationPlan,
  expectedTags: readonly Tag[],
  isCurrent: () => boolean = tagMutationSession(),
): Promise<void> {
  return changePersistedTags((records) => {
    const active = records.filter(tag => tag.deletedAt === undefined);
    const expected = new Map(expectedTags.map(tag => [tag.id, tag]));
    if (active.length !== expected.size || active.some(tag => {
      const snapshot = expected.get(tag.id);
      return !snapshot || !tagRecordsEqual(tag, snapshot);
    })) { throw new TagMutationStaleError(); }
    // An ID must never overwrite an outstanding deletion from another context.
    if (plan.upserts.some(tag => records.some(record => record.id === tag.id && record.deletedAt !== undefined))) {
      throw new TagMutationStaleError();
    }
    return { puts: [...plan.upserts, ...plan.tombstones], deletes: [] };
  }, isCurrent);
}
