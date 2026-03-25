import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("story:series cli", () => {
  it("creates a root series and then continues from its latest successful run", async () => {
    const seriesRoot = mkdtempSync(path.join(os.tmpdir(), "story-series-cli-"));
    const dbPathA = path.join(seriesRoot, "db-a.sqlite");
    const dbPathB = path.join(seriesRoot, "db-b.sqlite");

    try {
      const firstRun = await execa("npm", [
        "run",
        "story:series",
        "--",
        "--series=mainline-a",
        "--turns=3",
        "--stub-model",
        `--series-root=${seriesRoot}`,
      ], {
        cwd: repoRoot,
        env: buildStoryEnv(dbPathA),
      });

      expect(firstRun.stdout).toContain("series=mainline-a");
      expect(firstRun.stdout).toContain("mode=continue");

      const afterFirst = readSeriesMetadata(seriesRoot, "mainline-a");
      expect(afterFirst.latestRunId).toBeTruthy();
      expect(afterFirst.runCount).toBe(1);
      expect(afterFirst.totalChapterCount).toBe(1);
      expect(afterFirst.runs[0]?.status).toBe("success");

      const secondRun = await execa("npm", [
        "run",
        "story:series",
        "--",
        "--series=mainline-a",
        "--turns=3",
        "--stub-model",
        `--series-root=${seriesRoot}`,
      ], {
        cwd: repoRoot,
        env: buildStoryEnv(dbPathB),
      });

      expect(secondRun.stdout).toContain("series=mainline-a");
      expect(secondRun.stdout).toContain("mode=continue");

      const afterSecond = readSeriesMetadata(seriesRoot, "mainline-a");
      expect(afterSecond.runCount).toBe(2);
      expect(afterSecond.totalChapterCount).toBe(2);
      expect(afterSecond.latestRunId).not.toBe(afterFirst.latestRunId);
      expect(afterSecond.runs[1]?.continuedFromRunId).toBe(afterFirst.latestRunId);
      expect(readWorldLogTurnNumbers(afterSecond.runs[1]?.path ?? "")).toEqual([4, 5, 6]);
    } finally {
      rmSync(seriesRoot, { recursive: true, force: true });
    }
  });

  it("branches from an earlier successful run into a child series without mutating the source series", async () => {
    const seriesRoot = mkdtempSync(path.join(os.tmpdir(), "story-series-cli-"));
    const dbPathA = path.join(seriesRoot, "db-a.sqlite");
    const dbPathB = path.join(seriesRoot, "db-b.sqlite");
    const dbPathBranch = path.join(seriesRoot, "db-branch.sqlite");

    try {
      await execa("npm", [
        "run",
        "story:series",
        "--",
        "--series=mainline-a",
        "--turns=3",
        "--stub-model",
        `--series-root=${seriesRoot}`,
      ], {
        cwd: repoRoot,
        env: buildStoryEnv(dbPathA),
      });
      await execa("npm", [
        "run",
        "story:series",
        "--",
        "--series=mainline-a",
        "--turns=3",
        "--stub-model",
        `--series-root=${seriesRoot}`,
      ], {
        cwd: repoRoot,
        env: buildStoryEnv(dbPathB),
      });

      const sourceBeforeBranch = readSeriesMetadata(seriesRoot, "mainline-a");
      const branchFromRunId = sourceBeforeBranch.runs[0]?.runId;
      expect(branchFromRunId).toBeTruthy();

      const branchRun = await execa("npm", [
        "run",
        "story:series",
        "--",
        "--series=mainline-a",
        "--mode=branch",
        `--from-run=${branchFromRunId}`,
        "--turns=3",
        "--stub-model",
        `--series-root=${seriesRoot}`,
      ], {
        cwd: repoRoot,
        env: buildStoryEnv(dbPathBranch),
      });

      expect(branchRun.stdout).toContain("series=mainline-a-branch-01");
      expect(branchRun.stdout).toContain("mode=branch");

      const sourceAfterBranch = readSeriesMetadata(seriesRoot, "mainline-a");
      const childSeries = readSeriesMetadata(seriesRoot, "mainline-a-branch-01");

      expect(sourceAfterBranch).toEqual(sourceBeforeBranch);
      expect(childSeries.parentSeriesId).toBe("mainline-a");
      expect(childSeries.branchedFromRunId).toBe(branchFromRunId);
      expect(childSeries.runCount).toBe(1);
      expect(childSeries.runs[0]?.continuedFromRunId).toBe(branchFromRunId);
      expect(readWorldLogTurnNumbers(childSeries.runs[0]?.path ?? "")).toEqual([4, 5, 6]);
    } finally {
      rmSync(seriesRoot, { recursive: true, force: true });
    }
  });

  it("rejects branch without --from-run", async () => {
    const seriesRoot = mkdtempSync(path.join(os.tmpdir(), "story-series-cli-"));

    try {
      const result = await execa("npm", [
        "run",
        "story:series",
        "--",
        "--series=mainline-a",
        "--mode=branch",
        "--turns=3",
        "--stub-model",
        `--series-root=${seriesRoot}`,
      ], {
        cwd: repoRoot,
        reject: false,
        env: buildStoryEnv(path.join(seriesRoot, "db.sqlite")),
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--from-run");
    } finally {
      rmSync(seriesRoot, { recursive: true, force: true });
    }
  });

  it("rejects continue with a non-latest --from-run", async () => {
    const seriesRoot = mkdtempSync(path.join(os.tmpdir(), "story-series-cli-"));
    const dbPathA = path.join(seriesRoot, "db-a.sqlite");
    const dbPathB = path.join(seriesRoot, "db-b.sqlite");
    const dbPathC = path.join(seriesRoot, "db-c.sqlite");

    try {
      await execa("npm", [
        "run",
        "story:series",
        "--",
        "--series=mainline-a",
        "--turns=3",
        "--stub-model",
        `--series-root=${seriesRoot}`,
      ], {
        cwd: repoRoot,
        env: buildStoryEnv(dbPathA),
      });
      await execa("npm", [
        "run",
        "story:series",
        "--",
        "--series=mainline-a",
        "--turns=3",
        "--stub-model",
        `--series-root=${seriesRoot}`,
      ], {
        cwd: repoRoot,
        env: buildStoryEnv(dbPathB),
      });

      const seriesMeta = readSeriesMetadata(seriesRoot, "mainline-a");
      const firstRunId = seriesMeta.runs[0]?.runId;
      expect(firstRunId).toBeTruthy();

      const result = await execa("npm", [
        "run",
        "story:series",
        "--",
        "--series=mainline-a",
        `--from-run=${firstRunId}`,
        "--turns=3",
        "--stub-model",
        `--series-root=${seriesRoot}`,
      ], {
        cwd: repoRoot,
        reject: false,
        env: buildStoryEnv(dbPathC),
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("latest successful run");
    } finally {
      rmSync(seriesRoot, { recursive: true, force: true });
    }
  });

  it("rejects --output-dir because story:series is series-root driven", async () => {
    const seriesRoot = mkdtempSync(path.join(os.tmpdir(), "story-series-cli-"));

    try {
      const result = await execa("npm", [
        "run",
        "story:series",
        "--",
        "--series=mainline-a",
        "--turns=3",
        "--stub-model",
        `--series-root=${seriesRoot}`,
        "--output-dir=./runs",
      ], {
        cwd: repoRoot,
        reject: false,
        env: buildStoryEnv(path.join(seriesRoot, "db.sqlite")),
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--output-dir");
    } finally {
      rmSync(seriesRoot, { recursive: true, force: true });
    }
  });

  it("starts a brand-new series from a fresh world even when the shared DB already has prior story state", async () => {
    const seriesRoot = mkdtempSync(path.join(os.tmpdir(), "story-series-cli-"));
    const sharedDbPath = path.join(seriesRoot, "shared.sqlite");

    try {
      await execa("npm", [
        "run",
        "story:series",
        "--",
        "--series=mainline-a",
        "--turns=3",
        "--stub-model",
        `--series-root=${seriesRoot}`,
      ], {
        cwd: repoRoot,
        env: buildStoryEnv(sharedDbPath),
      });

      const pollutedDbRun = await execa("npm", [
        "run",
        "story:series",
        "--",
        "--series=mainline-b",
        "--turns=3",
        "--stub-model",
        `--series-root=${seriesRoot}`,
      ], {
        cwd: repoRoot,
        env: buildStoryEnv(sharedDbPath),
      });

      expect(pollutedDbRun.stdout).toContain("series=mainline-b");
      expect(pollutedDbRun.stdout).toContain("mode=continue");

      const freshSeries = readSeriesMetadata(seriesRoot, "mainline-b");
      expect(freshSeries.runCount).toBe(1);
      expect(freshSeries.runs[0]?.continuedFromRunId).toBeNull();
      expect(readWorldLogTurnNumbers(freshSeries.runs[0]?.path ?? "")).toEqual([1, 2, 3]);
      expect(readProjectedRelationIds(freshSeries.runs[0]?.path ?? "")).toEqual(expect.arrayContaining([
        "ssr-a-ember-seal-LOCATED_IN-l-fallen-realm",
        "ssr-a-ember-seal-OWNS-c-shen-mo",
      ]));
    } finally {
      rmSync(seriesRoot, { recursive: true, force: true });
    }
  });

  it("does not append a failed run when restore input is already corrupt", async () => {
    const seriesRoot = mkdtempSync(path.join(os.tmpdir(), "story-series-cli-"));
    const dbPathA = path.join(seriesRoot, "db-a.sqlite");
    const dbPathB = path.join(seriesRoot, "db-b.sqlite");

    try {
      await execa("npm", [
        "run",
        "story:series",
        "--",
        "--series=mainline-a",
        "--turns=3",
        "--stub-model",
        `--series-root=${seriesRoot}`,
      ], {
        cwd: repoRoot,
        env: buildStoryEnv(dbPathA),
      });

      const beforeCorruption = readSeriesMetadata(seriesRoot, "mainline-a");
      unlinkSync(path.join(beforeCorruption.runs[0]?.path ?? "", "state", "final-beliefs.json"));

      const result = await execa("npm", [
        "run",
        "story:series",
        "--",
        "--series=mainline-a",
        "--turns=3",
        "--stub-model",
        `--series-root=${seriesRoot}`,
      ], {
        cwd: repoRoot,
        reject: false,
        env: buildStoryEnv(dbPathB),
      });

      expect(result.exitCode).not.toBe(0);
      expect(readSeriesMetadata(seriesRoot, "mainline-a")).toEqual(beforeCorruption);
    } finally {
      rmSync(seriesRoot, { recursive: true, force: true });
    }
  });
});

function buildStoryEnv(dbPath: string) {
  return {
    ...process.env,
    NOVEL_LLM_MODE: "anthropic-compatible",
    NOVEL_DB_PATH: dbPath,
    NOVEL_CHAPTER_EVERY_TURNS: "3",
    NOVEL_RESET_ON_START: "1",
  };
}

function readSeriesMetadata(seriesRoot: string, seriesId: string): {
  latestRunId: string | null;
  runCount: number;
  totalChapterCount: number;
  parentSeriesId?: string;
  branchedFromRunId?: string;
  runs: Array<{
    runId: string;
    status: string;
    path?: string;
    continuedFromRunId?: string | null;
  }>;
} {
  return JSON.parse(
    readFileSync(path.join(seriesRoot, seriesId, "series.json"), "utf8"),
  ) as ReturnType<typeof readSeriesMetadata>;
}

function readWorldLogTurnNumbers(bundlePath: string): number[] {
  return readFileSync(path.join(bundlePath, "world-log.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { turnNumber: number }).turnNumber);
}

function readProjectedRelationIds(bundlePath: string): string[] {
  const world = JSON.parse(
    readFileSync(path.join(bundlePath, "state", "final-world.json"), "utf8"),
  ) as {
    projectedRelations?: Array<{ id: string }>;
  };
  return (world.projectedRelations ?? []).map((relation) => relation.id);
}
