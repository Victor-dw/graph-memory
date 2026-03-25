import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendSeriesRun,
  createRootSeriesMetadata,
  readSeriesMetadata,
  writeSeriesMetadata,
} from "../../src/story/series/metadata.ts";
import { runStoryLongRunCli } from "../../src/story/long-run-cli.ts";

const envKeys = [
  "NOVEL_LLM_MODE",
  "NOVEL_LLM_BASE_URL",
  "NOVEL_LLM_MODEL",
  "NOVEL_LLM_API_KEY",
  "NOVEL_DB_PATH",
  "NOVEL_CHAPTER_EVERY_TURNS",
  "NOVEL_RESET_ON_START",
] as const;

const originalEnv = new Map<string, string | undefined>(
  envKeys.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("story:long-run cli", () => {
  it("repeats stubbed story series runs and writes a resumable session summary", async () => {
    const seriesRoot = mkdtempSync(path.join(os.tmpdir(), "story-long-run-series-"));
    const controlRoot = mkdtempSync(path.join(os.tmpdir(), "story-long-run-control-"));
    const dbPath = path.join(seriesRoot, "novel.db");

    process.env.NOVEL_LLM_MODE = "anthropic-compatible";
    process.env.NOVEL_DB_PATH = dbPath;
    process.env.NOVEL_CHAPTER_EVERY_TURNS = "3";
    process.env.NOVEL_RESET_ON_START = "0";

    try {
      await runStoryLongRunCli([
        "--series=mainline-a",
        "--turns=3",
        "--stub-model",
        "--max-runs=2",
        "--duration-hours=1",
        "--label=test-session",
        `--series-root=${seriesRoot}`,
        `--control-dir=${controlRoot}`,
      ]);

      const metadata = readSeriesMetadata(seriesRoot, "mainline-a");
      const sessionDir = path.join(controlRoot, "test-session");
      const summary = JSON.parse(
        readFileSync(path.join(sessionDir, "summary.json"), "utf8"),
      ) as {
        status: string;
        completedRuns: number;
        failedRuns: number;
        lastRunId: string | null;
        stopFilePath: string;
        lastRunMetrics?: {
          relations: number;
          projectedRelations: number;
          threadState: number;
          identities: number;
          executes_in_projected: number;
          executes_in_legacy: number;
          consistency_issues: number;
        };
      };
      const events = readJsonLines(path.join(sessionDir, "events.jsonl"));
      const runSucceededEvent = events.find((event) => event.type === "run-succeeded");

      expect(metadata.runCount).toBe(2);
      expect(metadata.totalChapterCount).toBe(2);
      expect(summary.status).toBe("completed");
      expect(summary.completedRuns).toBe(2);
      expect(summary.failedRuns).toBe(0);
      expect(summary.lastRunId).toBe(metadata.latestRunId);
      expect(summary.stopFilePath).toBe(path.join(sessionDir, "STOP"));
      expect(summary.lastRunMetrics).toEqual(expect.objectContaining({
        relations: expect.any(Number),
        projectedRelations: expect.any(Number),
        threadState: expect.any(Number),
        identities: expect.any(Number),
        executes_in_projected: expect.any(Number),
        executes_in_legacy: expect.any(Number),
        consistency_issues: expect.any(Number),
      }));
      expect(existsSync(path.join(sessionDir, "events.jsonl"))).toBe(true);
      expect(runSucceededEvent).toEqual(expect.objectContaining({
        bundleMetrics: expect.objectContaining({
          relations: expect.any(Number),
          projectedRelations: expect.any(Number),
          threadState: expect.any(Number),
          identities: expect.any(Number),
          executes_in_projected: expect.any(Number),
          executes_in_legacy: expect.any(Number),
          consistency_issues: expect.any(Number),
        }),
      }));
    } finally {
      rmSync(seriesRoot, { recursive: true, force: true });
      rmSync(controlRoot, { recursive: true, force: true });
    }
  });

  it("fails fast when the non-stub MiniMax runtime env is misconfigured", async () => {
    const seriesRoot = mkdtempSync(path.join(os.tmpdir(), "story-long-run-series-"));
    const controlRoot = mkdtempSync(path.join(os.tmpdir(), "story-long-run-control-"));

    process.env.NOVEL_LLM_MODE = "openai-compatible";
    process.env.NOVEL_LLM_BASE_URL = "https://api.minimaxi.com/anthropic";
    process.env.NOVEL_LLM_MODEL = "MiniMax-M2.7";
    process.env.NOVEL_LLM_API_KEY = "bad-key";
    process.env.NOVEL_DB_PATH = path.join(seriesRoot, "novel.db");
    process.env.NOVEL_CHAPTER_EVERY_TURNS = "3";
    process.env.NOVEL_RESET_ON_START = "0";

    try {
      await expect(runStoryLongRunCli([
        "--series=mainline-a",
        "--turns=3",
        "--max-runs=1",
        "--duration-hours=1",
        `--series-root=${seriesRoot}`,
        `--control-dir=${controlRoot}`,
      ])).rejects.toThrow("[story-long-run] NOVEL_LLM_MODE must stay anthropic-compatible for MiniMax runs");
    } finally {
      rmSync(seriesRoot, { recursive: true, force: true });
      rmSync(controlRoot, { recursive: true, force: true });
    }
  });

  it("stops cleanly before the first iteration when a stop file is present", async () => {
    const seriesRoot = mkdtempSync(path.join(os.tmpdir(), "story-long-run-series-"));
    const controlRoot = mkdtempSync(path.join(os.tmpdir(), "story-long-run-control-"));
    const sessionDir = path.join(controlRoot, "stop-now");
    const stopFilePath = path.join(sessionDir, "STOP");
    const dbPath = path.join(seriesRoot, "novel.db");

    process.env.NOVEL_LLM_MODE = "anthropic-compatible";
    process.env.NOVEL_DB_PATH = dbPath;
    process.env.NOVEL_CHAPTER_EVERY_TURNS = "3";
    process.env.NOVEL_RESET_ON_START = "0";

    try {
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(stopFilePath, "stop\n", "utf8");

      await runStoryLongRunCli([
        "--series=mainline-a",
        "--turns=3",
        "--stub-model",
        "--max-runs=3",
        "--duration-hours=1",
        "--label=stop-now",
        `--series-root=${seriesRoot}`,
        `--control-dir=${controlRoot}`,
      ]);

      const summary = JSON.parse(
        readFileSync(path.join(sessionDir, "summary.json"), "utf8"),
      ) as { status: string; completedRuns: number };

      expect(summary.status).toBe("stopped");
      expect(summary.completedRuns).toBe(0);
      expect(existsSync(path.join(seriesRoot, "mainline-a", "series.json"))).toBe(false);
    } finally {
      rmSync(seriesRoot, { recursive: true, force: true });
      rmSync(controlRoot, { recursive: true, force: true });
    }
  });

  it("starts a fresh first iteration for a brand-new series even when long-run reuses a dirty shared DB", async () => {
    const seriesRoot = mkdtempSync(path.join(os.tmpdir(), "story-long-run-series-"));
    const controlRoot = mkdtempSync(path.join(os.tmpdir(), "story-long-run-control-"));
    const dbPath = path.join(seriesRoot, "shared.sqlite");

    process.env.NOVEL_LLM_MODE = "anthropic-compatible";
    process.env.NOVEL_DB_PATH = dbPath;
    process.env.NOVEL_CHAPTER_EVERY_TURNS = "3";
    process.env.NOVEL_RESET_ON_START = "0";

    try {
      await runStoryLongRunCli([
        "--series=mainline-a",
        "--turns=3",
        "--stub-model",
        "--max-runs=1",
        "--duration-hours=1",
        "--label=seed-dirty-db",
        `--series-root=${seriesRoot}`,
        `--control-dir=${controlRoot}`,
      ]);

      await runStoryLongRunCli([
        "--series=mainline-b",
        "--turns=3",
        "--stub-model",
        "--max-runs=1",
        "--duration-hours=1",
        "--label=fresh-on-dirty-db",
        `--series-root=${seriesRoot}`,
        `--control-dir=${controlRoot}`,
      ]);

      const metadata = readSeriesMetadata(seriesRoot, "mainline-b");
      const sessionDir = path.join(controlRoot, "fresh-on-dirty-db");
      const summary = JSON.parse(
        readFileSync(path.join(sessionDir, "summary.json"), "utf8"),
      ) as {
        status: string;
        completedRuns: number;
        lastRunId: string | null;
      };
      const events = readJsonLines(path.join(sessionDir, "events.jsonl"));
      const runSucceededEvent = events.find((event) => event.type === "run-succeeded");

      expect(metadata.runCount).toBe(1);
      expect(metadata.runs[0]?.continuedFromRunId).toBeNull();
      expect(readWorldLogTurnNumbers(metadata.runs[0]?.path ?? "")).toEqual([1, 2, 3]);
      expect(summary.status).toBe("completed");
      expect(summary.completedRuns).toBe(1);
      expect(summary.lastRunId).toBe(metadata.latestRunId);
      expect(runSucceededEvent).toEqual(expect.objectContaining({
        latestRunId: metadata.latestRunId,
        bundleMetrics: expect.objectContaining({
          projectedRelations: expect.any(Number),
        }),
      }));
    } finally {
      rmSync(seriesRoot, { recursive: true, force: true });
      rmSync(controlRoot, { recursive: true, force: true });
    }
  });

  it("marks metricsUnavailable when bundle metrics files are missing or invalid but still completes the run", async () => {
    const seriesRoot = mkdtempSync(path.join(os.tmpdir(), "story-long-run-series-"));
    const controlRoot = mkdtempSync(path.join(os.tmpdir(), "story-long-run-control-"));
    const dbPath = path.join(seriesRoot, "novel.db");
    let runOrdinal = 0;

    process.env.NOVEL_LLM_MODE = "anthropic-compatible";
    process.env.NOVEL_DB_PATH = dbPath;
    process.env.NOVEL_CHAPTER_EVERY_TURNS = "3";
    process.env.NOVEL_RESET_ON_START = "0";

    try {
      await runStoryLongRunCli([
        "--series=mainline-a",
        "--turns=3",
        "--stub-model",
        "--max-runs=1",
        "--duration-hours=1",
        "--label=metrics-unavailable",
        `--series-root=${seriesRoot}`,
        `--control-dir=${controlRoot}`,
      ], {
        runSeries: async () => {
          runOrdinal += 1;
          const runId = `stub-run-${runOrdinal}`;
          const bundlePath = path.join(seriesRoot, "mainline-a", "runs", runId);
          const stateDir = path.join(bundlePath, "state");
          mkdirSync(stateDir, { recursive: true });
          writeFileSync(path.join(stateDir, "final-world.json"), "{invalid json", "utf8");

          const metadata = existsSync(path.join(seriesRoot, "mainline-a", "series.json"))
            ? readSeriesMetadata(seriesRoot, "mainline-a")
            : createRootSeriesMetadata({
              seriesId: "mainline-a",
              createdAt: "2026-03-25T00:00:00.000Z",
            });

          writeSeriesMetadata(seriesRoot, appendSeriesRun(metadata, {
            runId,
            startedAt: "2026-03-25T00:00:00.000Z",
            finishedAt: "2026-03-25T00:00:01.000Z",
            turnCount: 3,
            chapterCount: 1,
            path: bundlePath,
            status: "success",
          }));
        },
      });

      const sessionDir = path.join(controlRoot, "metrics-unavailable");
      const summary = JSON.parse(
        readFileSync(path.join(sessionDir, "summary.json"), "utf8"),
      ) as {
        status: string;
        completedRuns: number;
        failedRuns: number;
        metricsUnavailable?: boolean;
        lastRunMetricsWarning?: string;
      };
      const events = readJsonLines(path.join(sessionDir, "events.jsonl"));
      const runSucceededEvent = events.find((event) => event.type === "run-succeeded");

      expect(summary.status).toBe("completed");
      expect(summary.completedRuns).toBe(1);
      expect(summary.failedRuns).toBe(0);
      expect(summary.metricsUnavailable).toBe(true);
      expect(summary.lastRunMetricsWarning).toEqual(expect.stringContaining("final-world.json"));
      expect(runSucceededEvent).toEqual(expect.objectContaining({
        metricsUnavailable: true,
        warning: expect.stringContaining("final-world.json"),
      }));
    } finally {
      rmSync(seriesRoot, { recursive: true, force: true });
      rmSync(controlRoot, { recursive: true, force: true });
    }
  });
});

function readJsonLines(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readWorldLogTurnNumbers(bundlePath: string): number[] {
  return readFileSync(path.join(bundlePath, "world-log.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { turnNumber: number }).turnNumber);
}
