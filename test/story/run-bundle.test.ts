import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDb } from "../helpers.ts";
import { initializeStoryWorld } from "../../src/story/world-state.ts";
import { runStoryLoop } from "../../src/story/runtime/run-loop.ts";
import { createStubStoryModelClient } from "../../src/story/runtime/stub-model.ts";
import { writeRunBundle } from "../../src/story/output/run-bundle.ts";
import { upsertProjectedRelation, upsertThreadState } from "../../src/store/store.ts";

describe("story run bundle", () => {
  it("writes the complete bundle layout for a short stubbed run", async () => {
    const db = createTestDb();
    const outputDir = mkdtempSync(path.join(os.tmpdir(), "story-run-bundle-"));
    const startedAt = "2026-03-22T10:00:00.000Z";
    const finishedAt = "2026-03-22T10:00:05.000Z";

    try {
      initializeStoryWorld(db);
      const loopResult = await runStoryLoop(db, {
        turns: 3,
        model: createStubStoryModelClient(),
      });

      const bundle = await writeRunBundle(db, loopResult, {
        outputRoot: outputDir,
        runMetadata: {
          runId: "test-run-001",
          turns: 3,
          chapterEveryTurns: 3,
          dbPath: "/tmp/story.db",
          resetOnStart: true,
          model: { mode: "stub", name: "stub-story-model" },
          startedAt,
          finishedAt,
        },
      });

      expect(bundle).toMatchObject({
        runId: "test-run-001",
        bundlePath: path.join(outputDir, "test-run-001"),
        turnCount: 3,
        chapterCount: 1,
        consistencyIssueCount: 0,
      });

      expect(existsSync(path.join(bundle.bundlePath, "index.json"))).toBe(true);
      expect(existsSync(path.join(bundle.bundlePath, "world-log.jsonl"))).toBe(true);
      expect(existsSync(path.join(bundle.bundlePath, "chapters", "chapter-001.md"))).toBe(true);
      expect(existsSync(path.join(bundle.bundlePath, "state", "final-world.json"))).toBe(true);
      expect(existsSync(path.join(bundle.bundlePath, "state", "final-beliefs.json"))).toBe(true);
      expect(existsSync(path.join(bundle.bundlePath, "state", "final-director.json"))).toBe(true);
      expect(existsSync(path.join(bundle.bundlePath, "state", "consistency.json"))).toBe(true);

      const index = JSON.parse(readFileSync(path.join(bundle.bundlePath, "index.json"), "utf8")) as {
        schemaVersion: number;
        runId: string;
        startedAt: string;
        finishedAt: string;
        turnCount: number;
        chapterCount: number;
        consistencyIssueCount: number;
        chapterEveryTurns: number;
        dbPath: string;
        resetOnStart: boolean;
        model: { mode: string; name: string };
        bundlePath: string;
        outputRoot: string;
        seriesId: string | null;
        seriesMode: string | null;
        continuedFromRunId: string | null;
        branchedFromRunId: string | null;
        parentSeriesId: string | null;
      };
      expect(index.schemaVersion).toBe(1);
      expect(index.runId).toBe("test-run-001");
      expect(index.startedAt).toBe(startedAt);
      expect(index.finishedAt).toBe(finishedAt);
      expect(index.turnCount).toBe(3);
      expect(index.chapterCount).toBe(1);
      expect(index.consistencyIssueCount).toBe(0);
      expect(index.chapterEveryTurns).toBe(3);
      expect(index.dbPath).toBe("/tmp/story.db");
      expect(index.resetOnStart).toBe(true);
      expect(index.model).toEqual({ mode: "stub", name: "stub-story-model" });
      expect(index.bundlePath).toBe(path.join(outputDir, "test-run-001"));
      expect(index.outputRoot).toBe(outputDir);
      expect(index.seriesId).toBeNull();
      expect(index.seriesMode).toBeNull();
      expect(index.continuedFromRunId).toBeNull();
      expect(index.branchedFromRunId).toBeNull();
      expect(index.parentSeriesId).toBeNull();

      const worldLogLines = readFileSync(path.join(bundle.bundlePath, "world-log.jsonl"), "utf8")
        .trim()
        .split("\n");
      expect(worldLogLines).toHaveLength(3);

      const chapterMarkdown = readFileSync(path.join(bundle.bundlePath, "chapters", "chapter-001.md"), "utf8");
      expect(chapterMarkdown).toContain("# Chapter 001");
      expect(chapterMarkdown).toContain("- Run: test-run-001");
      expect(chapterMarkdown).toContain("- Turn: 3");
      expect(chapterMarkdown).toContain("- Summary: ");
      expect(chapterMarkdown).toMatch(/\n\nStub chapter turn 3 focus /);
    } finally {
      db.close();
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("keeps exported chapters aligned to persisted turn order", async () => {
    const db = createTestDb();
    const outputDir = mkdtempSync(path.join(os.tmpdir(), "story-run-bundle-"));
    const startedAt = "2026-03-22T10:00:00.000Z";
    const finishedAt = "2026-03-22T10:00:05.000Z";

    try {
      initializeStoryWorld(db);
      const loopResult = await runStoryLoop(db, {
        turns: 6,
        model: createStubStoryModelClient(),
      });

      db.prepare(`
        UPDATE story_chapters
        SET created_at = CASE turn_number
          WHEN 3 THEN 2000
          WHEN 6 THEN 1000
          ELSE created_at
        END
        WHERE turn_number IN (3, 6)
      `).run();

      const bundle = await writeRunBundle(db, loopResult, {
        outputRoot: outputDir,
        runMetadata: {
          runId: "test-run-002",
          turns: 6,
          chapterEveryTurns: 3,
          dbPath: "/tmp/story.db",
          resetOnStart: true,
          model: { mode: "stub", name: "stub-story-model" },
          startedAt,
          finishedAt,
        },
      });

      expect(bundle.chapterCount).toBe(2);

      const chapter001 = readFileSync(path.join(bundle.bundlePath, "chapters", "chapter-001.md"), "utf8");
      const chapter002 = readFileSync(path.join(bundle.bundlePath, "chapters", "chapter-002.md"), "utf8");

      expect(chapter001).toContain("- Turn: 3");
      expect(chapter002).toContain("- Turn: 6");
    } finally {
      db.close();
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("exports schema v2 continuation state alongside final-world snapshot", async () => {
    const db = createTestDb();
    const outputDir = mkdtempSync(path.join(os.tmpdir(), "story-run-bundle-"));

    try {
      initializeStoryWorld(db);
      const loopResult = await runStoryLoop(db, {
        turns: 3,
        model: createStubStoryModelClient(),
      });
      upsertProjectedRelation(db, {
        id: "ssr-ember-seal-conflict",
        fromIdentityId: "a-ember-seal",
        relation: "IN_CONFLICT",
        toIdentityId: "conflict:a-ember-seal",
        visibility: "public",
        derivedFromEventId: "sle-sev-3-1",
        validFromTurn: 3,
      });
      upsertThreadState(db, {
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

      const bundle = await writeRunBundle(db, loopResult, {
        outputRoot: outputDir,
        runMetadata: {
          runId: "test-run-v2-world",
          turns: 3,
          chapterEveryTurns: 3,
          dbPath: "/tmp/story.db",
          resetOnStart: true,
          model: { mode: "stub", name: "stub-story-model" },
          startedAt: "2026-03-22T10:00:00.000Z",
          finishedAt: "2026-03-22T10:00:05.000Z",
        },
      });

      const world = JSON.parse(readFileSync(path.join(bundle.bundlePath, "state", "final-world.json"), "utf8")) as {
        identities?: Array<{ id: string; kind: string; aliases?: unknown[] }>;
        projectedRelations?: Array<{ id: string; toIdentityId: string; validFromTurn?: number }>;
        threadState?: Array<{ threadId: string; stage: string; lastEventId?: string }>;
      };

      expect(world.identities).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: "conflict:a-ember-seal",
          kind: "thread",
        }),
      ]));
      expect(world.projectedRelations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: "ssr-ember-seal-conflict",
          toIdentityId: "conflict:a-ember-seal",
          validFromTurn: 3,
        }),
      ]));
      expect(world.threadState).toEqual(expect.arrayContaining([
        expect.objectContaining({
          threadId: "t-secret-realm",
          stage: "showdown",
          lastEventId: "sle-sev-3-1",
        }),
      ]));
    } finally {
      db.close();
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
