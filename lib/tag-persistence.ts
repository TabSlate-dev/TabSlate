import * as idb from "@/lib/idb";
import type { TagMutationPlan } from "@/lib/tag-mutations";
import { buildTagTree } from "@/lib/tag-tree";
import { unusedTagIds } from "@/lib/tag-counts";
import type { Bookmark, Tag } from "@/lib/types";

export class TagMutationStaleError extends Error {
  constructor() {
    super("Tag records changed before the mutation committed");
    this.name = "TagMutationStaleError";
  }
}

export class TagMutationQuotaError extends Error {
  constructor() {
    super("Tag quota exceeded");
    this.name = "TagMutationQuotaError";
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

export interface BookmarkBucketChanges {
  active: Bookmark[];
  archived: Bookmark[];
  trashed: Bookmark[];
}

export interface CommittedTagMutation {
  /** The actual upserts and tombstones written by this transaction. */
  tags: Tag[];
  bookmarks: BookmarkBucketChanges;
}

export interface TagCommitOptions {
  /** Recheck only the proposed unused candidates against all durable buckets. */
  unusedOnly?: boolean;
  /** Maximum active tags allowed in IDB. Throws TagMutationQuotaError if breached. */
  maxActiveTags?: number;
}

export async function commitTagMutation(
  plan: TagMutationPlan,
  expectedTags: readonly Tag[],
  isCurrent: () => boolean = tagMutationSession(),
  options: TagCommitOptions = {},
): Promise<CommittedTagMutation> {
  const committed: CommittedTagMutation = { tags: [], bookmarks: { active: [], archived: [], trashed: [] } };
  const needsBookmarks = plan.replacements.size > 0 || options.unusedOnly;
  const buckets = ["bookmarks", "archived-bookmarks", "trashed-bookmarks"] as const;
  let failure: Error | undefined;
  let activeTransaction: IDBTransaction | undefined;
  try {
    await idb.idbTransaction(needsBookmarks ? ["tags", ...buckets] : ["tags"], "readwrite", (transaction) => {
      activeTransaction = transaction;
      transactions.add(transaction);
      let records: Tag[] | undefined;
      const bookmarks: Bookmark[][] = [];
      let remaining = needsBookmarks ? 4 : 1;
      const finishRead = () => {
        remaining -= 1;
        if (remaining > 0) { return; }
        try {
          if (!isCurrent() || !records) { throw new TagMutationStaleError(); }
          const durableTags = records;
          const active = durableTags.filter(tag => tag.deletedAt === undefined);
          const expected = new Map(expectedTags.map(tag => [tag.id, tag]));
          if (active.length !== expected.size || active.some(tag => {
            const snapshot = expected.get(tag.id);
            return !snapshot || !tagRecordsEqual(tag, snapshot);
          })) { throw new TagMutationStaleError(); }
          if (plan.upserts.some(tag => durableTags.some(record => record.id === tag.id && record.deletedAt !== undefined))) {
            throw new TagMutationStaleError();
          }
          if (options.maxActiveTags !== undefined && options.maxActiveTags !== -1) {
            const created = plan.upserts.filter(tag => !active.some(existing => existing.id === tag.id)).length;
            if (active.length + created > options.maxActiveTags) {
              throw new TagMutationQuotaError();
            }
          }
          const unused = options.unusedOnly ? unusedTagIds(buildTagTree(active, "en"), bookmarks.flat()) : undefined;
          committed.tags = [...plan.upserts, ...plan.tombstones.filter(tag => !unused || unused.has(tag.id))];
          const now = Date.now();
          const changedBuckets = [committed.bookmarks.active, committed.bookmarks.archived, committed.bookmarks.trashed];
          for (const [index, bucket] of buckets.entries()) {
            for (const bookmark of bookmarks[index] ?? []) {
              if (!bookmark.tags.some(id => plan.replacements.has(id))) { continue; }
              const tags = [...new Set(bookmark.tags.map(id => plan.replacements.get(id) ?? id))];
              if (tags.length === bookmark.tags.length && tags.every((id, position) => id === bookmark.tags[position])) { continue; }
              const updated = { ...bookmark, tags, seq: 0, updatedAt: now };
              transaction.objectStore(bucket).put(updated);
              changedBuckets[index].push(updated);
            }
          }
          for (const tag of committed.tags) { transaction.objectStore("tags").put(tag); }
        } catch (error) {
          failure = error instanceof Error ? error : new Error("Tag mutation failed");
          transaction.abort();
        }
      };
      const tagsRequest: IDBRequest<Tag[]> = transaction.objectStore("tags").getAll();
      tagsRequest.onerror = () => transaction.abort();
      tagsRequest.onsuccess = () => { records = tagsRequest.result; finishRead(); };
      if (needsBookmarks) {
        for (const [index, bucket] of buckets.entries()) {
          const request: IDBRequest<Bookmark[]> = transaction.objectStore(bucket).getAll();
          request.onerror = () => transaction.abort();
          request.onsuccess = () => { bookmarks[index] = request.result; finishRead(); };
        }
      }
    });
  } catch (error) {
    if (!isCurrent()) { throw new TagMutationStaleError(); }
    throw failure ?? error;
  } finally {
    if (activeTransaction) { transactions.delete(activeTransaction); }
  }
  return committed;
}
