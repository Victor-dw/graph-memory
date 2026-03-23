import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendSeriesRun,
  countSuccessfulTurnsThroughRun,
  createBranchSeriesMetadata,
  createRootSeriesMetadata,
  readSeriesMetadata,
  writeSeriesMetadata,
} from "../../src/story/series/metadata.ts";
import { deriveChildSeriesId, resolveSeriesPath, resolveSeriesRoot, resolveSeriesRunPath } from "../../src/story/series/layout.ts";

describe("story series metadata", () => {
  it("creates a root series with nullable latestRunId and zero chapter count", () => {
    const meta = createRootSeriesMetadata({
      seriesId: "mainline-a",
      createdAt: "2026-03-23T00:00:00.000Z",
    });

    expect(meta).toMatchObject({
      schemaVersion: 1,
      seriesId: "mainline-a",
      type: "mainline",
      mode: "root",
      latestRunId: null,
      runCount: 0,
      totalChapterCount: 0,
      runs: [],
    });
    expect(meta.createdAt).toBe("2026-03-23T00:00:00.000Z");
    expect(meta.updatedAt).toBe("2026-03-23T00:00:00.000Z");
  });

  it("records successful runs as the latest continuation point and advances series chapter counters", () => {
    const baseMeta = createRootSeriesMetadata({
      seriesId: "mainline-a",
      createdAt: "2026-03-23T00:00:00.000Z",
    });

    const meta = appendSeriesRun(baseMeta, {
      runId: "run-001",
      startedAt: "2026-03-23T01:00:00.000Z",
      finishedAt: "2026-03-23T01:05:00.000Z",
      turnCount: 6,
      chapterCount: 2,
      path: "/tmp/series/mainline-a/runs/run-001",
      status: "success",
      continuedFromRunId: null,
    });

    expect(meta.latestRunId).toBe("run-001");
    expect(meta.runCount).toBe(1);
    expect(meta.totalChapterCount).toBe(2);
    expect(meta.runs).toHaveLength(1);
    expect(meta.runs[0]).toMatchObject({
      runId: "run-001",
      status: "success",
      seriesChapterStart: 1,
      seriesChapterEnd: 2,
      continuedFromRunId: null,
    });
  });

  it("does not advance latestRunId or totalChapterCount for failed runs", () => {
    const baseMeta = appendSeriesRun(
      createRootSeriesMetadata({
        seriesId: "mainline-a",
        createdAt: "2026-03-23T00:00:00.000Z",
      }),
      {
        runId: "run-001",
        startedAt: "2026-03-23T01:00:00.000Z",
        finishedAt: "2026-03-23T01:05:00.000Z",
        turnCount: 9,
        chapterCount: 3,
        path: "/tmp/series/mainline-a/runs/run-001",
        status: "success",
      },
    );

    const meta = appendSeriesRun(baseMeta, {
      runId: "run-002",
      startedAt: "2026-03-23T02:00:00.000Z",
      finishedAt: "2026-03-23T02:01:00.000Z",
      turnCount: 2,
      chapterCount: 1,
      path: "/tmp/series/mainline-a/runs/run-002",
      status: "failed",
      continuedFromRunId: "run-001",
    });

    expect(meta.latestRunId).toBe("run-001");
    expect(meta.runCount).toBe(2);
    expect(meta.totalChapterCount).toBe(3);
    expect(meta.runs[1]).toMatchObject({
      runId: "run-002",
      status: "failed",
      continuedFromRunId: "run-001",
    });
    expect(meta.runs[1].seriesChapterStart).toBeUndefined();
    expect(meta.runs[1].seriesChapterEnd).toBeUndefined();
  });

  it("derives readable child branch ids and branch metadata lineage", () => {
    expect(deriveChildSeriesId("mainline-a", 1)).toBe("mainline-a-branch-01");

    const meta = createBranchSeriesMetadata({
      seriesId: "mainline-a-branch-01",
      parentSeriesId: "mainline-a",
      branchedFromRunId: "run-003",
      createdAt: "2026-03-23T03:00:00.000Z",
    });

    expect(meta).toMatchObject({
      seriesId: "mainline-a-branch-01",
      type: "alternate",
      mode: "branch",
      parentSeriesId: "mainline-a",
      branchedFromRunId: "run-003",
      latestRunId: null,
    });
  });

  it("writes and reloads series metadata from series.json", () => {
    const seriesRoot = mkdtempSync(path.join(os.tmpdir(), "story-series-meta-"));

    try {
      const meta = appendSeriesRun(
        createRootSeriesMetadata({
          seriesId: "mainline-a",
          createdAt: "2026-03-23T00:00:00.000Z",
        }),
        {
          runId: "run-001",
          startedAt: "2026-03-23T01:00:00.000Z",
          finishedAt: "2026-03-23T01:05:00.000Z",
          turnCount: 6,
          chapterCount: 2,
          path: "/tmp/series/mainline-a/runs/run-001",
          status: "success",
        },
      );

      writeSeriesMetadata(seriesRoot, meta);

      const seriesPath = resolveSeriesPath(seriesRoot, "mainline-a");
      const reloaded = readSeriesMetadata(seriesRoot, "mainline-a");
      const storedJson = JSON.parse(readFileSync(path.join(seriesPath, "series.json"), "utf8")) as {
        seriesId: string;
      };

      expect(storedJson.seriesId).toBe("mainline-a");
      expect(reloaded).toEqual(meta);
    } finally {
      rmSync(seriesRoot, { recursive: true, force: true });
    }
  });

  it("rejects malformed series metadata files at the read boundary", () => {
    const seriesRoot = mkdtempSync(path.join(os.tmpdir(), "story-series-meta-"));

    try {
      const seriesPath = resolveSeriesPath(seriesRoot, "mainline-a");
      mkdirSync(seriesPath, { recursive: true });
      writeFileSync(path.join(seriesPath, "series.json"), `${JSON.stringify({
        schemaVersion: 1,
        seriesId: "mainline-a",
        type: "mainline",
        mode: "root",
        createdAt: "2026-03-23T00:00:00.000Z",
        updatedAt: "2026-03-23T00:00:00.000Z",
        latestRunId: "missing-success-run",
        runCount: 0,
        totalChapterCount: 0,
        runs: [],
      }, null, 2)}\n`, "utf8");

      expect(() => readSeriesMetadata(seriesRoot, "mainline-a")).toThrowError(
        "[story-series] invalid series metadata",
      );
      expect(readFileSync(path.join(seriesPath, "series.json"), "utf8")).toContain("missing-success-run");
    } finally {
      rmSync(seriesRoot, { recursive: true, force: true });
    }
  });

  it("rejects stale latestRunId values that do not match the newest successful run", () => {
    const seriesRoot = mkdtempSync(path.join(os.tmpdir(), "story-series-meta-"));

    try {
      const seriesPath = resolveSeriesPath(seriesRoot, "mainline-a");
      mkdirSync(seriesPath, { recursive: true });
      writeFileSync(path.join(seriesPath, "series.json"), `${JSON.stringify({
        schemaVersion: 1,
        seriesId: "mainline-a",
        type: "mainline",
        mode: "root",
        createdAt: "2026-03-23T00:00:00.000Z",
        updatedAt: "2026-03-23T02:00:00.000Z",
        latestRunId: "run-001",
        runCount: 2,
        totalChapterCount: 2,
        runs: [
          {
            runId: "run-001",
            startedAt: "2026-03-23T01:00:00.000Z",
            finishedAt: "2026-03-23T01:05:00.000Z",
            turnCount: 3,
            chapterCount: 1,
            path: "/tmp/series/mainline-a/runs/run-001",
            status: "success",
            seriesChapterStart: 1,
            seriesChapterEnd: 1,
          },
          {
            runId: "run-002",
            startedAt: "2026-03-23T02:00:00.000Z",
            finishedAt: "2026-03-23T02:05:00.000Z",
            turnCount: 3,
            chapterCount: 1,
            path: "/tmp/series/mainline-a/runs/run-002",
            status: "success",
            continuedFromRunId: "run-001",
            seriesChapterStart: 2,
            seriesChapterEnd: 2,
          },
        ],
      }, null, 2)}\n`, "utf8");

      expect(() => readSeriesMetadata(seriesRoot, "mainline-a")).toThrowError(
        "[story-series] invalid series metadata",
      );
    } finally {
      rmSync(seriesRoot, { recursive: true, force: true });
    }
  });

  it("rejects branch metadata that omits required lineage fields", () => {
    const seriesRoot = mkdtempSync(path.join(os.tmpdir(), "story-series-meta-"));

    try {
      const seriesPath = resolveSeriesPath(seriesRoot, "mainline-a-branch-01");
      mkdirSync(seriesPath, { recursive: true });
      writeFileSync(path.join(seriesPath, "series.json"), `${JSON.stringify({
        schemaVersion: 1,
        seriesId: "mainline-a-branch-01",
        type: "alternate",
        mode: "branch",
        createdAt: "2026-03-23T03:00:00.000Z",
        updatedAt: "2026-03-23T03:00:00.000Z",
        latestRunId: null,
        runCount: 0,
        totalChapterCount: 0,
        runs: [],
      }, null, 2)}\n`, "utf8");

      expect(() => readSeriesMetadata(seriesRoot, "mainline-a-branch-01")).toThrowError(
        "[story-series] invalid series metadata",
      );
    } finally {
      rmSync(seriesRoot, { recursive: true, force: true });
    }
  });

  it("rejects totalChapterCount values that do not match successful run history", () => {
    const seriesRoot = mkdtempSync(path.join(os.tmpdir(), "story-series-meta-"));

    try {
      const seriesPath = resolveSeriesPath(seriesRoot, "mainline-a");
      mkdirSync(seriesPath, { recursive: true });
      writeFileSync(path.join(seriesPath, "series.json"), `${JSON.stringify({
        schemaVersion: 1,
        seriesId: "mainline-a",
        type: "mainline",
        mode: "root",
        createdAt: "2026-03-23T00:00:00.000Z",
        updatedAt: "2026-03-23T03:00:00.000Z",
        latestRunId: "run-002",
        runCount: 3,
        totalChapterCount: 99,
        runs: [
          {
            runId: "run-001",
            startedAt: "2026-03-23T01:00:00.000Z",
            finishedAt: "2026-03-23T01:05:00.000Z",
            turnCount: 3,
            chapterCount: 2,
            path: "/tmp/series/mainline-a/runs/run-001",
            status: "success",
            seriesChapterStart: 1,
            seriesChapterEnd: 2,
          },
          {
            runId: "run-failed",
            startedAt: "2026-03-23T02:00:00.000Z",
            finishedAt: "2026-03-23T02:05:00.000Z",
            turnCount: 1,
            chapterCount: 4,
            path: "/tmp/series/mainline-a/runs/run-failed",
            status: "failed",
          },
          {
            runId: "run-002",
            startedAt: "2026-03-23T03:00:00.000Z",
            finishedAt: "2026-03-23T03:05:00.000Z",
            turnCount: 2,
            chapterCount: 1,
            path: "/tmp/series/mainline-a/runs/run-002",
            status: "success",
            seriesChapterStart: 3,
            seriesChapterEnd: 3,
          },
        ],
      }, null, 2)}\n`, "utf8");

      expect(() => readSeriesMetadata(seriesRoot, "mainline-a")).toThrowError(
        "[story-series] invalid series metadata",
      );
    } finally {
      rmSync(seriesRoot, { recursive: true, force: true });
    }
  });

  it("rejects successful run chapter ranges that do not match cumulative chapter history", () => {
    const seriesRoot = mkdtempSync(path.join(os.tmpdir(), "story-series-meta-"));

    try {
      const seriesPath = resolveSeriesPath(seriesRoot, "mainline-a");
      mkdirSync(seriesPath, { recursive: true });
      writeFileSync(path.join(seriesPath, "series.json"), `${JSON.stringify({
        schemaVersion: 1,
        seriesId: "mainline-a",
        type: "mainline",
        mode: "root",
        createdAt: "2026-03-23T00:00:00.000Z",
        updatedAt: "2026-03-23T03:00:00.000Z",
        latestRunId: "run-002",
        runCount: 2,
        totalChapterCount: 3,
        runs: [
          {
            runId: "run-001",
            startedAt: "2026-03-23T01:00:00.000Z",
            finishedAt: "2026-03-23T01:05:00.000Z",
            turnCount: 3,
            chapterCount: 2,
            path: "/tmp/series/mainline-a/runs/run-001",
            status: "success",
            seriesChapterStart: 1,
            seriesChapterEnd: 2,
          },
          {
            runId: "run-002",
            startedAt: "2026-03-23T03:00:00.000Z",
            finishedAt: "2026-03-23T03:05:00.000Z",
            turnCount: 2,
            chapterCount: 1,
            path: "/tmp/series/mainline-a/runs/run-002",
            status: "success",
            seriesChapterStart: 4,
            seriesChapterEnd: 4,
          },
        ],
      }, null, 2)}\n`, "utf8");

      expect(() => readSeriesMetadata(seriesRoot, "mainline-a")).toThrowError(
        "[story-series] invalid series metadata",
      );
    } finally {
      rmSync(seriesRoot, { recursive: true, force: true });
    }
  });

  it("rejects syntactically corrupted series metadata files", () => {
    const seriesRoot = mkdtempSync(path.join(os.tmpdir(), "story-series-meta-"));

    try {
      const seriesPath = resolveSeriesPath(seriesRoot, "mainline-a");
      mkdirSync(seriesPath, { recursive: true });
      writeFileSync(path.join(seriesPath, "series.json"), "{not-json\n", "utf8");

      expect(() => readSeriesMetadata(seriesRoot, "mainline-a")).toThrowError(
        "[story-series] invalid series metadata",
      );
    } finally {
      rmSync(seriesRoot, { recursive: true, force: true });
    }
  });

  it("rejects invalid run append invariants", () => {
    const baseMeta = appendSeriesRun(
      createRootSeriesMetadata({
        seriesId: "mainline-a",
        createdAt: "2026-03-23T00:00:00.000Z",
      }),
      {
        runId: "run-001",
        startedAt: "2026-03-23T01:00:00.000Z",
        finishedAt: "2026-03-23T01:05:00.000Z",
        turnCount: 3,
        chapterCount: 1,
        path: "/tmp/series/mainline-a/runs/run-001",
        status: "success",
      },
    );

    expect(() => appendSeriesRun(baseMeta, {
      runId: "run-001",
      startedAt: "2026-03-23T02:00:00.000Z",
      finishedAt: "2026-03-23T02:01:00.000Z",
      turnCount: 3,
      chapterCount: 1,
      path: "/tmp/series/mainline-a/runs/run-001",
      status: "success",
    })).toThrowError("[story-series] duplicate runId");

    expect(() => appendSeriesRun(baseMeta, {
      runId: "run-002",
      startedAt: "2026-03-23T02:00:00.000Z",
      finishedAt: "2026-03-23T02:01:00.000Z",
      turnCount: -1,
      chapterCount: 1,
      path: "/tmp/series/mainline-a/runs/run-002",
      status: "success",
    })).toThrowError("[story-series] turnCount must be a non-negative integer");
  });

  it("allows running records without fake completion timestamps", () => {
    const meta = appendSeriesRun(
      createRootSeriesMetadata({
        seriesId: "mainline-a",
        createdAt: "2026-03-23T00:00:00.000Z",
      }),
      {
        runId: "run-001",
        startedAt: "2026-03-23T01:00:00.000Z",
        turnCount: 0,
        chapterCount: 0,
        path: "/tmp/series/mainline-a/runs/run-001",
        status: "running",
      },
    );

    expect(meta.runCount).toBe(1);
    expect(meta.latestRunId).toBeNull();
    expect(meta.runs[0]?.finishedAt).toBeUndefined();
    expect(meta.runs[0]?.status).toBe("running");
  });

  it("counts cumulative successful turns through a source run", () => {
    const meta = appendSeriesRun(
      appendSeriesRun(
        createRootSeriesMetadata({
          seriesId: "mainline-a",
          createdAt: "2026-03-23T00:00:00.000Z",
        }),
        {
          runId: "run-001",
          startedAt: "2026-03-23T01:00:00.000Z",
          finishedAt: "2026-03-23T01:05:00.000Z",
          turnCount: 3,
          chapterCount: 1,
          path: "/tmp/series/mainline-a/runs/run-001",
          status: "success",
        },
      ),
      {
        runId: "run-002",
        startedAt: "2026-03-23T02:00:00.000Z",
        finishedAt: "2026-03-23T02:05:00.000Z",
        turnCount: 4,
        chapterCount: 1,
        path: "/tmp/series/mainline-a/runs/run-002",
        status: "success",
        continuedFromRunId: "run-001",
      },
    );

    expect(countSuccessfulTurnsThroughRun(meta, "run-001")).toBe(3);
    expect(countSuccessfulTurnsThroughRun(meta, "run-002")).toBe(7);
  });
});

describe("story series layout", () => {
  it("resolves the default series root and run paths", () => {
    const root = resolveSeriesRoot();
    const explicitRoot = resolveSeriesRoot("./series-fixture");

    expect(root).toBe(path.join(process.cwd(), "series"));
    expect(explicitRoot).toBe(path.join(process.cwd(), "series-fixture"));
    expect(resolveSeriesPath(explicitRoot, "mainline-a")).toBe(
      path.join(explicitRoot, "mainline-a"),
    );
    expect(resolveSeriesRunPath(explicitRoot, "mainline-a", "run-001")).toBe(
      path.join(explicitRoot, "mainline-a", "runs", "run-001"),
    );
  });

  it("rejects unsafe path segments from user-provided ids", () => {
    const root = resolveSeriesRoot("./series-fixture");

    expect(() => resolveSeriesPath(root, "../escape")).toThrowError(
      "[story-series] invalid path segment",
    );
    expect(() => resolveSeriesRunPath(root, "mainline-a", "nested/run-001")).toThrowError(
      "[story-series] invalid path segment",
    );
  });
});
