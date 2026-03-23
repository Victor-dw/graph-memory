import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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

      expect(readCount(targetDb, "story_turns")).toBe(0);
      expect(readCount(targetDb, "story_events")).toBe(0);
      expect(readCount(targetDb, "story_chapters")).toBe(0);
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

function normalizeWorldSnapshot(snapshot: ReturnType<typeof buildStoryWorldSnapshot>) {
  return {
    ...snapshot,
    entities: [...snapshot.entities].sort((a, b) => a.id.localeCompare(b.id)),
    relations: [...snapshot.relations].sort((a, b) => a.id.localeCompare(b.id)),
    activeThreads: [...snapshot.activeThreads].sort((a, b) => a.id.localeCompare(b.id)),
    narrativeSignals: [...snapshot.narrativeSignals].sort((a, b) => a.id.localeCompare(b.id)),
  };
}
