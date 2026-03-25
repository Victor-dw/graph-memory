import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDb } from "../helpers.ts";
import { buildStoryBeliefSnapshot } from "../../src/story/beliefs.ts";
import { buildStoryWorldSnapshot } from "../../src/story/memory/consistency.ts";
import { loadDirectorState } from "../../src/story/narrative/state.ts";
import { writeRunBundle } from "../../src/story/output/run-bundle.ts";
import { createStubStoryModelClient } from "../../src/story/runtime/stub-model.ts";
import { runStoryLoop } from "../../src/story/runtime/run-loop.ts";
import { restoreSeriesRun } from "../../src/story/series/restore.ts";
import { initializeStoryWorld } from "../../src/story/world-state.ts";
import { upsertProjectedRelation, upsertThreadState } from "../../src/store/store.ts";

describe("story series restore", () => {
  it("rehydrates canonical world, beliefs, and director state from a prior run bundle", async () => {
    const sourceDb = createTestDb();
    const targetDb = createTestDb();
    const outputRoot = mkdtempSync(path.join(os.tmpdir(), "story-series-restore-"));

    try {
      initializeStoryWorld(sourceDb);
      const loopResult = await runStoryLoop(sourceDb, {
        turns: 3,
        model: createStubStoryModelClient(),
      });
      upsertProjectedRelation(sourceDb, {
        id: "ssr-ember-seal-conflict",
        fromIdentityId: "a-ember-seal",
        relation: "IN_CONFLICT",
        toIdentityId: "conflict:a-ember-seal",
        visibility: "public",
        derivedFromEventId: "sle-sev-3-1",
        validFromTurn: 3,
      });
      upsertThreadState(sourceDb, {
        threadId: "t-secret-realm",
        stage: "showdown",
        urgency: 0.9,
        pressure: 0.95,
        focusIdentityId: "c-li-yao",
        lastAdvancedTurn: 3,
        lastEventId: "sle-sev-3-1",
        blockingFactorsJson: "[]",
        pendingPayoffsJson: '["stabilize-t-secret-realm"]',
      });
      const sourceWorld = buildStoryWorldSnapshot(sourceDb);
      const sourceBeliefs = sortBeliefs(buildStoryBeliefSnapshot(sourceDb));
      const sourceDirector = loopResult.finalDirectorState;

      const bundle = await writeRunBundle(sourceDb, loopResult, {
        outputRoot,
        runMetadata: {
          runId: "restore-source-run",
          turns: 3,
          chapterEveryTurns: 3,
          dbPath: "/tmp/story.db",
          resetOnStart: true,
          model: { mode: "stub", name: "stub-story-model" },
          startedAt: "2026-03-23T08:00:00.000Z",
          finishedAt: "2026-03-23T08:00:05.000Z",
        },
      });

      initializeStoryWorld(targetDb);
      await restoreSeriesRun(targetDb, { bundlePath: bundle.bundlePath });

      expect(normalizeWorldSnapshot(buildStoryWorldSnapshot(targetDb))).toEqual(
        normalizeWorldSnapshot(sourceWorld),
      );
      expect(buildStoryWorldSnapshot(targetDb).relations.map((relation) => relation.id)).toEqual(
        sourceWorld.relations.map((relation) => relation.id),
      );
      expect(buildStoryWorldSnapshot(targetDb).narrativeSignals.map((signal) => signal.id)).toEqual(
        sourceWorld.narrativeSignals.map((signal) => signal.id),
      );
      expect(sortBeliefs(buildStoryBeliefSnapshot(targetDb))).toEqual(sourceBeliefs);
      expect(loadDirectorState(targetDb)).toEqual(sourceDirector);
      expect(readValueCount(targetDb, "story_identities", "id", "conflict:a-ember-seal")).toBe(1);
      expect(readValueCount(targetDb, "story_state_relations", "id", "ssr-ember-seal-conflict")).toBe(1);
      expect(readValueCount(targetDb, "story_thread_state", "thread_id", "t-secret-realm")).toBe(1);

      expect(readCount(targetDb, "story_turns")).toBe(0);
      expect(readCount(targetDb, "story_events")).toBe(0);
      expect(readCount(targetDb, "story_chapters")).toBe(0);
    } finally {
      sourceDb.close();
      targetDb.close();
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it("restores legacy-compatible snapshots when optional v2 world fields are omitted", async () => {
    const sourceDb = createTestDb();
    const targetDb = createTestDb();
    const outputRoot = mkdtempSync(path.join(os.tmpdir(), "story-series-restore-"));

    try {
      initializeStoryWorld(sourceDb);
      const loopResult = await runStoryLoop(sourceDb, {
        turns: 3,
        model: createStubStoryModelClient(),
      });
      const sourceWorld = buildStoryWorldSnapshot(sourceDb);
      const sourceBeliefs = sortBeliefs(buildStoryBeliefSnapshot(sourceDb));
      const sourceDirector = loopResult.finalDirectorState;
      const bundle = await writeRunBundle(sourceDb, loopResult, {
        outputRoot,
        runMetadata: {
          runId: "restore-legacy-compatible-run",
          turns: 3,
          chapterEveryTurns: 3,
          dbPath: "/tmp/story.db",
          resetOnStart: true,
          model: { mode: "stub", name: "stub-story-model" },
          startedAt: "2026-03-23T08:00:00.000Z",
          finishedAt: "2026-03-23T08:00:05.000Z",
        },
      });
      const worldPath = path.join(bundle.bundlePath, "state", "final-world.json");
      const world = JSON.parse(readUtf8(worldPath)) as Record<string, unknown>;
      delete world.identities;
      delete world.projectedRelations;
      delete world.threadState;
      writeFileSync(worldPath, `${JSON.stringify(world, null, 2)}\n`, "utf8");

      initializeStoryWorld(targetDb);
      await restoreSeriesRun(targetDb, { bundlePath: bundle.bundlePath });
      const restoredWorld = buildStoryWorldSnapshot(targetDb);

      expect(restoredWorld.entities.map((entity) => entity.id).sort()).toEqual(
        sourceWorld.entities.map((entity) => entity.id).sort(),
      );
      expect(restoredWorld.activeThreads).toEqual(sourceWorld.activeThreads);
      expect(restoredWorld.narrativeSignals.map((signal) => signal.id)).toEqual(
        sourceWorld.narrativeSignals.map((signal) => signal.id),
      );
      expect(readValueCount(targetDb, "story_state_relations", "id", "ssr-a-ember-seal-OWNS-c-shen-mo")).toBe(1);
      expect(readValueCount(targetDb, "story_state_relations", "id", "ssr-a-ember-seal-IN_CONFLICT-conflict:a-ember-seal")).toBe(0);
      expect(readValueCount(targetDb, "story_thread_state", "thread_id", "t-secret-realm")).toBe(1);
      expect(sortBeliefs(buildStoryBeliefSnapshot(targetDb))).toEqual(sourceBeliefs);
      expect(loadDirectorState(targetDb)).toEqual(sourceDirector);
    } finally {
      sourceDb.close();
      targetDb.close();
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it("reconstructs v2 tables from legacy-carried fallback fields when explicit v2 sections are omitted", async () => {
    const sourceDb = createTestDb();
    const targetDb = createTestDb();
    const outputRoot = mkdtempSync(path.join(os.tmpdir(), "story-series-restore-"));

    try {
      initializeStoryWorld(sourceDb);
      const loopResult = await runStoryLoop(sourceDb, {
        turns: 3,
        model: createStubStoryModelClient(),
      });
      const sourceWorld = buildStoryWorldSnapshot(sourceDb);
      const bundle = await writeRunBundle(sourceDb, loopResult, {
        outputRoot,
        runMetadata: {
          runId: "restore-fallback-v2-run",
          turns: 3,
          chapterEveryTurns: 3,
          dbPath: "/tmp/story.db",
          resetOnStart: true,
          model: { mode: "stub", name: "stub-story-model" },
          startedAt: "2026-03-23T08:00:00.000Z",
          finishedAt: "2026-03-23T08:00:05.000Z",
        },
      });
      const worldPath = path.join(bundle.bundlePath, "state", "final-world.json");
      const world = JSON.parse(readUtf8(worldPath)) as Record<string, unknown>;
      world.relations = sourceWorld.relations;
      world.activeThreads = sourceWorld.activeThreads;
      delete world.identities;
      delete world.projectedRelations;
      delete world.threadState;
      writeFileSync(worldPath, `${JSON.stringify(world, null, 2)}\n`, "utf8");

      await restoreSeriesRun(targetDb, { bundlePath: bundle.bundlePath });

      expect(readValueCount(targetDb, "story_state_relations", "id", "ssr-a-ember-seal-IN_CONFLICT-conflict:a-ember-seal")).toBe(1);
      expect(readValueCount(targetDb, "story_thread_state", "thread_id", "t-secret-realm")).toBe(1);
    } finally {
      sourceDb.close();
      targetDb.close();
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it("fails clearly when a required continuation snapshot is missing", async () => {
    const sourceDb = createTestDb();
    const targetDb = createTestDb();
    const outputRoot = mkdtempSync(path.join(os.tmpdir(), "story-series-restore-"));

    try {
      initializeStoryWorld(sourceDb);
      const loopResult = await runStoryLoop(sourceDb, {
        turns: 3,
        model: createStubStoryModelClient(),
      });
      const bundle = await writeRunBundle(sourceDb, loopResult, {
        outputRoot,
        runMetadata: {
          runId: "restore-source-run",
          turns: 3,
          chapterEveryTurns: 3,
          dbPath: "/tmp/story.db",
          resetOnStart: true,
          model: { mode: "stub", name: "stub-story-model" },
          startedAt: "2026-03-23T08:00:00.000Z",
          finishedAt: "2026-03-23T08:00:05.000Z",
        },
      });
      unlinkSync(path.join(bundle.bundlePath, "state", "final-beliefs.json"));

      await expect(
        restoreSeriesRun(targetDb, { bundlePath: bundle.bundlePath }),
      ).rejects.toThrowError("[story-series] missing required snapshot");
    } finally {
      sourceDb.close();
      targetDb.close();
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it("rejects malformed optional schema v2 world sections", async () => {
    const sourceDb = createTestDb();
    const targetDb = createTestDb();
    const outputRoot = mkdtempSync(path.join(os.tmpdir(), "story-series-restore-"));

    try {
      initializeStoryWorld(sourceDb);
      const loopResult = await runStoryLoop(sourceDb, {
        turns: 3,
        model: createStubStoryModelClient(),
      });
      const bundle = await writeRunBundle(sourceDb, loopResult, {
        outputRoot,
        runMetadata: {
          runId: "restore-malformed-v2-run",
          turns: 3,
          chapterEveryTurns: 3,
          dbPath: "/tmp/story.db",
          resetOnStart: true,
          model: { mode: "stub", name: "stub-story-model" },
          startedAt: "2026-03-23T08:00:00.000Z",
          finishedAt: "2026-03-23T08:00:05.000Z",
        },
      });
      const worldPath = path.join(bundle.bundlePath, "state", "final-world.json");
      const world = JSON.parse(readUtf8(worldPath)) as Record<string, unknown>;
      world.projectedRelations = [{ id: "broken-projection" }];
      writeFileSync(worldPath, `${JSON.stringify(world, null, 2)}\n`, "utf8");

      await expect(
        restoreSeriesRun(targetDb, { bundlePath: bundle.bundlePath }),
      ).rejects.toThrowError(`[story-series] invalid snapshot shape: ${worldPath}`);
    } finally {
      sourceDb.close();
      targetDb.close();
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it("fails with the offending file path when a snapshot shape is invalid", async () => {
    const sourceDb = createTestDb();
    const targetDb = createTestDb();
    const outputRoot = mkdtempSync(path.join(os.tmpdir(), "story-series-restore-"));

    try {
      initializeStoryWorld(sourceDb);
      const loopResult = await runStoryLoop(sourceDb, {
        turns: 3,
        model: createStubStoryModelClient(),
      });
      const bundle = await writeRunBundle(sourceDb, loopResult, {
        outputRoot,
        runMetadata: {
          runId: "restore-source-run",
          turns: 3,
          chapterEveryTurns: 3,
          dbPath: "/tmp/story.db",
          resetOnStart: true,
          model: { mode: "stub", name: "stub-story-model" },
          startedAt: "2026-03-23T08:00:00.000Z",
          finishedAt: "2026-03-23T08:00:05.000Z",
        },
      });
      writeFileSync(path.join(bundle.bundlePath, "state", "final-world.json"), "{}\n", "utf8");

      await expect(
        restoreSeriesRun(targetDb, { bundlePath: bundle.bundlePath }),
      ).rejects.toThrowError("final-world.json");
    } finally {
      sourceDb.close();
      targetDb.close();
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it("rejects an empty director snapshot before restore mutates runtime state", async () => {
    const sourceDb = createTestDb();
    const targetDb = createTestDb();
    const outputRoot = mkdtempSync(path.join(os.tmpdir(), "story-series-restore-"));

    try {
      initializeStoryWorld(sourceDb);
      const loopResult = await runStoryLoop(sourceDb, {
        turns: 3,
        model: createStubStoryModelClient(),
      });
      const bundle = await writeRunBundle(sourceDb, loopResult, {
        outputRoot,
        runMetadata: {
          runId: "restore-source-run",
          turns: 3,
          chapterEveryTurns: 3,
          dbPath: "/tmp/story.db",
          resetOnStart: true,
          model: { mode: "stub", name: "stub-story-model" },
          startedAt: "2026-03-23T08:00:00.000Z",
          finishedAt: "2026-03-23T08:00:05.000Z",
        },
      });
      const directorPath = path.join(bundle.bundlePath, "state", "final-director.json");
      writeFileSync(directorPath, "{}\n", "utf8");

      await expect(
        restoreSeriesRun(targetDb, { bundlePath: bundle.bundlePath }),
      ).rejects.toThrowError(`[story-series] invalid snapshot shape: ${directorPath}`);
    } finally {
      sourceDb.close();
      targetDb.close();
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it("rejects malformed belief entries before SQLite writes begin", async () => {
    const sourceDb = createTestDb();
    const targetDb = createTestDb();
    const outputRoot = mkdtempSync(path.join(os.tmpdir(), "story-series-restore-"));

    try {
      initializeStoryWorld(sourceDb);
      const loopResult = await runStoryLoop(sourceDb, {
        turns: 3,
        model: createStubStoryModelClient(),
      });
      const bundle = await writeRunBundle(sourceDb, loopResult, {
        outputRoot,
        runMetadata: {
          runId: "restore-source-run",
          turns: 3,
          chapterEveryTurns: 3,
          dbPath: "/tmp/story.db",
          resetOnStart: true,
          model: { mode: "stub", name: "stub-story-model" },
          startedAt: "2026-03-23T08:00:00.000Z",
          finishedAt: "2026-03-23T08:00:05.000Z",
        },
      });
      const beliefsPath = path.join(bundle.bundlePath, "state", "final-beliefs.json");
      writeFileSync(beliefsPath, "[{}]\n", "utf8");

      await expect(
        restoreSeriesRun(targetDb, { bundlePath: bundle.bundlePath }),
      ).rejects.toThrowError(`[story-series] invalid snapshot shape: ${beliefsPath}`);
    } finally {
      sourceDb.close();
      targetDb.close();
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it("fails at the read boundary when a world entity payload is malformed", async () => {
    const sourceDb = createTestDb();
    const targetDb = createTestDb();
    const outputRoot = mkdtempSync(path.join(os.tmpdir(), "story-series-restore-"));

    try {
      initializeStoryWorld(sourceDb);
      const loopResult = await runStoryLoop(sourceDb, {
        turns: 3,
        model: createStubStoryModelClient(),
      });
      const bundle = await writeRunBundle(sourceDb, loopResult, {
        outputRoot,
        runMetadata: {
          runId: "restore-source-run",
          turns: 3,
          chapterEveryTurns: 3,
          dbPath: "/tmp/story.db",
          resetOnStart: true,
          model: { mode: "stub", name: "stub-story-model" },
          startedAt: "2026-03-23T08:00:00.000Z",
          finishedAt: "2026-03-23T08:00:05.000Z",
        },
      });
      const worldPath = path.join(bundle.bundlePath, "state", "final-world.json");
      const world = JSON.parse(readUtf8(worldPath)) as {
        entities: Array<{ id: string; kind: string; name: string; payload: unknown }>;
      };
      world.entities[0] = {
        ...world.entities[0],
        payload: { id: 42, name: "Broken entity" },
      };
      writeFileSync(worldPath, `${JSON.stringify(world, null, 2)}\n`, "utf8");

      await expect(
        restoreSeriesRun(targetDb, { bundlePath: bundle.bundlePath }),
      ).rejects.toThrowError(`[story-series] invalid snapshot shape: ${worldPath}`);
    } finally {
      sourceDb.close();
      targetDb.close();
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it("fails at the read boundary when director state contains malformed inner values", async () => {
    const sourceDb = createTestDb();
    const targetDb = createTestDb();
    const outputRoot = mkdtempSync(path.join(os.tmpdir(), "story-series-restore-"));

    try {
      initializeStoryWorld(sourceDb);
      const loopResult = await runStoryLoop(sourceDb, {
        turns: 3,
        model: createStubStoryModelClient(),
      });
      const bundle = await writeRunBundle(sourceDb, loopResult, {
        outputRoot,
        runMetadata: {
          runId: "restore-source-run",
          turns: 3,
          chapterEveryTurns: 3,
          dbPath: "/tmp/story.db",
          resetOnStart: true,
          model: { mode: "stub", name: "stub-story-model" },
          startedAt: "2026-03-23T08:00:00.000Z",
          finishedAt: "2026-03-23T08:00:05.000Z",
        },
      });
      const directorPath = path.join(bundle.bundlePath, "state", "final-director.json");
      const director = JSON.parse(readUtf8(directorPath)) as { recentPovIds: unknown[] };
      director.recentPovIds = ["c-li-yao", 99];
      writeFileSync(directorPath, `${JSON.stringify(director, null, 2)}\n`, "utf8");

      await expect(
        restoreSeriesRun(targetDb, { bundlePath: bundle.bundlePath }),
      ).rejects.toThrowError(`[story-series] invalid snapshot shape: ${directorPath}`);
    } finally {
      sourceDb.close();
      targetDb.close();
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });
});

function sortBeliefs(
  beliefs: Array<{
    actorId: string;
    subjectId: string;
    predicate: string;
    objectId: string;
    confidence: number;
    actorKind: string;
  }>,
) {
  return [...beliefs].sort((a, b) =>
    a.actorId.localeCompare(b.actorId)
    || a.subjectId.localeCompare(b.subjectId)
    || a.predicate.localeCompare(b.predicate)
    || a.objectId.localeCompare(b.objectId),
  );
}

function readCount(db: ReturnType<typeof createTestDb>, table: "story_turns" | "story_events" | "story_chapters"): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number } | undefined;
  return row?.count ?? 0;
}

function readValueCount(
  db: ReturnType<typeof createTestDb>,
  table: "story_identities" | "story_state_relations" | "story_thread_state",
  column: "id" | "thread_id",
  value: string,
): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(value) as
    | { count: number }
    | undefined;
  return row?.count ?? 0;
}

function normalizeWorldSnapshot(snapshot: ReturnType<typeof buildStoryWorldSnapshot>) {
  return {
    ...snapshot,
    entities: [...snapshot.entities].sort((a, b) => a.id.localeCompare(b.id)),
    relations: [...snapshot.relations].sort((a, b) => a.id.localeCompare(b.id)),
    activeThreads: [...snapshot.activeThreads].sort((a, b) => a.id.localeCompare(b.id)),
    narrativeSignals: [...snapshot.narrativeSignals].sort((a, b) => a.id.localeCompare(b.id)),
    identities: [...(snapshot.identities ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
    projectedRelations: [...(snapshot.projectedRelations ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
    threadState: [...(snapshot.threadState ?? [])].sort((a, b) => a.threadId.localeCompare(b.threadId)),
  };
}

function readUtf8(filePath: string): string {
  return readFileSync(filePath, "utf8");
}
