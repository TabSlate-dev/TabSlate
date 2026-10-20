// @ts-expect-error Bun provides this test module at runtime.
import { describe, expect, test } from "bun:test";
import type { SyncEntity, SyncPushPayload } from "@/lib/api";
import { importFresh } from "./helpers/module-replacer";

const {
  MAX_SYNC_ENTITIES_PER_PUSH,
  MAX_SYNC_PUSH_BYTES,
  createEmptySyncPushPayload,
  splitSyncPushPayload,
} = await importFresh<typeof import("@/lib/sync-recovery")>("lib/sync-recovery.ts");

const SERVER_MAX_BODY_BYTES = 512 * 1024;

function bookmarkEntity(id: string, notes = ""): SyncEntity {
  return {
    id,
    collection_id: "c",
    title: id,
    url: `https://example.com/${id}`,
    notes,
    tag_ids: [],
    position: 0,
    seq: 0,
  };
}

function payloadOf(entities: Partial<SyncPushPayload["entities"]>): SyncPushPayload {
  const payload = createEmptySyncPushPayload();
  Object.assign(payload.entities, entities);
  return payload;
}

function entityBytes(entity: SyncEntity): number {
  return new TextEncoder().encode(JSON.stringify(entity)).length + 1;
}

function bodyBytes(payload: SyncPushPayload): number {
  return new TextEncoder().encode(
    JSON.stringify({ ...payload, protocol_version: 2 }),
  ).length;
}

function chunkContents(chunks: SyncPushPayload[]): string[][] {
  return chunks.map((chunk) => [
    ...chunk.entities.workspaces.map((entity) => `workspaces:${entity.id}`),
    ...chunk.entities.collections.map((entity) => `collections:${entity.id}`),
    ...chunk.entities.bookmarks.map((entity) => `bookmarks:${entity.id}`),
    ...chunk.entities.tags.map((entity) => `tags:${entity.id}`),
    ...chunk.entities.groups.map((entity) => `groups:${entity.id}`),
  ]);
}

function expectNormalChunkBodiesUnderServerLimit(chunks: SyncPushPayload[]): void {
  for (const chunk of chunks) {
    const entities = Object.values(chunk.entities).flat();
    const entityBudget = entities.reduce((sum, entity) => sum + entityBytes(entity), 0);
    expect(entities.length).toBeLessThanOrEqual(MAX_SYNC_ENTITIES_PER_PUSH);
    if (entityBudget <= MAX_SYNC_PUSH_BYTES) {
      expect(bodyBytes(chunk)).toBeLessThan(SERVER_MAX_BODY_BYTES);
    } else {
      expect(entities).toHaveLength(1);
      expect(entityBytes(entities[0])).toBeGreaterThan(MAX_SYNC_PUSH_BYTES);
    }
  }
}

describe("splitSyncPushPayload", () => {
  test("returns a payload within both limits as it is", () => {
    const payload = payloadOf({ bookmarks: [bookmarkEntity("a")] });
    const chunks = splitSyncPushPayload(payload);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(payload);
    expectNormalChunkBodiesUnderServerLimit(chunks);
  });

  test("splits bookmarks with long notes so every normal body stays below the server limit", () => {
    const longNote = "笔".repeat(10_000);
    const bookmarks = Array.from({ length: 20 }, (_, index) =>
      bookmarkEntity(`b${index}`, longNote),
    );

    const chunks = splitSyncPushPayload(payloadOf({ bookmarks }));

    expect(chunks.length).toBeGreaterThan(1);
    expectNormalChunkBodiesUnderServerLimit(chunks);
    expect(chunks.flatMap((chunk) => chunk.entities.bookmarks.map((entity) => entity.id))).toEqual(
      bookmarks.map((entity) => entity.id),
    );
  });

  test("keeps non-bookmark entities ahead of bookmarks when it splits", () => {
    const longNote = "x".repeat(200_000);
    const chunks = splitSyncPushPayload(payloadOf({
      collections: [{ id: "c1", name: "One" }],
      tags: [{ id: "t1", name: "Tag" }],
      bookmarks: [bookmarkEntity("b1", longNote), bookmarkEntity("b2", longNote)],
    }));

    expect(chunkContents(chunks)).toEqual([
      ["collections:c1", "tags:t1"],
      ["bookmarks:b1"],
      ["bookmarks:b2"],
    ]);
    expectNormalChunkBodiesUnderServerLimit(chunks);
  });

  test("sends an entity over the byte budget on its own", () => {
    const chunks = splitSyncPushPayload(payloadOf({
      bookmarks: [
        bookmarkEntity("before"),
        bookmarkEntity("huge", "x".repeat(MAX_SYNC_PUSH_BYTES)),
        bookmarkEntity("after"),
      ],
    }));

    expect(chunks.map((chunk) => chunk.entities.bookmarks.map((entity) => entity.id))).toEqual([
      ["before"],
      ["huge"],
      ["after"],
    ]);
    expectNormalChunkBodiesUnderServerLimit(chunks);
  });

  test("still limits each request to the entity count", () => {
    const bookmarks = Array.from(
      { length: MAX_SYNC_ENTITIES_PER_PUSH + 1 },
      (_, index) => bookmarkEntity(`b${index}`),
    );
    const chunks = splitSyncPushPayload(payloadOf({ bookmarks }));

    expect(chunks.map((chunk) => chunk.entities.bookmarks.length)).toEqual([
      MAX_SYNC_ENTITIES_PER_PUSH,
      1,
    ]);
    expectNormalChunkBodiesUnderServerLimit(chunks);
  });
});
