import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import {
  appendSeriesRun,
  createRootSeriesMetadata,
  writeSeriesMetadata,
} from "../../src/story/series/metadata.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const cliPath = path.join(repoRoot, "src/story/series-metrics-cli.ts");

describe("story:series-metrics cli", () => {
  it("prints first/latest/all run metrics plus first-vs-latest deltas", async () => {
    const seriesRoot = mkdtempSync(path.join(os.tmpdir(), "story-series-metrics-"));

    try {
      seedSeriesFixture(seriesRoot, "mainline-a");

      const result = await runCli([
        `--series-root=${seriesRoot}`,
        "--series=mainline-a",
      ]);
      const output = parseKeyValueOutput(result.stdout);

      expect(output.series).toBe("mainline-a");
      expect(output.seriesRoot).toBe(seriesRoot);
      expect(output.successfulRunCount).toBe("2");
      expect(output.firstRunId).toBe("story-run-001");
      expect(output.latestRunId).toBe("story-run-003");

      expect(output["first.relations"]).toBe("2");
      expect(output["first.projectedRelations"]).toBe("2");
      expect(output["first.threadState"]).toBe("1");
      expect(output["first.identities"]).toBe("2");
      expect(output["first.executes_in_projected"]).toBe("1");
      expect(output["first.executes_in_legacy"]).toBe("1");
      expect(output["first.consistency_issues"]).toBe("1");

      expect(output["latest.relations"]).toBe("1");
      expect(output["latest.projectedRelations"]).toBe("1");
      expect(output["latest.threadState"]).toBe("2");
      expect(output["latest.identities"]).toBe("3");
      expect(output["latest.executes_in_projected"]).toBe("0");
      expect(output["latest.executes_in_legacy"]).toBe("0");
      expect(output["latest.consistency_issues"]).toBe("0");

      expect(output["all.relations.min"]).toBe("1");
      expect(output["all.relations.max"]).toBe("2");
      expect(output["all.relations.avg"]).toBe("1.50");
      expect(output["all.executes_in_legacy.avg"]).toBe("0.50");
      expect(output["all.consistency_issues.avg"]).toBe("0.50");

      expect(output["compare.first_vs_latest.relations.delta"]).toBe("-1");
      expect(output["compare.first_vs_latest.threadState.delta"]).toBe("1");
      expect(output["compare.first_vs_latest.identities.delta"]).toBe("1");
      expect(output["compare.first_vs_latest.executes_in_projected.delta"]).toBe("-1");
      expect(output["compare.first_vs_latest.executes_in_legacy.delta"]).toBe("-1");
      expect(output["compare.first_vs_latest.consistency_issues.delta"]).toBe("-1");
    } finally {
      rmSync(seriesRoot, { recursive: true, force: true });
    }
  });

  it("fails with a clear message when required args are missing", async () => {
    const result = await runCli(["--series=mainline-a"], { reject: false });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[story-series-metrics] --series-root is required");
  });

  it("fails when the series metadata is missing", async () => {
    const seriesRoot = mkdtempSync(path.join(os.tmpdir(), "story-series-metrics-"));

    try {
      const result = await runCli([
        `--series-root=${seriesRoot}`,
        "--series=missing-series",
      ], {
        reject: false,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("missing metadata for series=missing-series");
    } finally {
      rmSync(seriesRoot, { recursive: true, force: true });
    }
  });

  it("fails when no successful run exists in series metadata", async () => {
    const seriesRoot = mkdtempSync(path.join(os.tmpdir(), "story-series-metrics-"));
    const seriesId = "mainline-no-success";
    let metadata = createRootSeriesMetadata({
      seriesId,
      createdAt: "2026-03-25T10:00:00.000Z",
    });
    metadata = appendSeriesRun(metadata, {
      runId: "story-run-failed",
      startedAt: "2026-03-25T10:00:00.000Z",
      finishedAt: "2026-03-25T10:01:00.000Z",
      turnCount: 0,
      chapterCount: 0,
      path: path.join(seriesRoot, seriesId, "runs", "story-run-failed"),
      status: "failed",
    });
    writeSeriesMetadata(seriesRoot, metadata);

    try {
      const result = await runCli([
        `--series-root=${seriesRoot}`,
        `--series=${seriesId}`,
      ], { reject: false });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("[story-series-metrics] no successful runs found");
    } finally {
      rmSync(seriesRoot, { recursive: true, force: true });
    }
  });

  it("fails with run id and file path when bundle state is incomplete", async () => {
    const seriesRoot = mkdtempSync(path.join(os.tmpdir(), "story-series-metrics-"));
    const seriesId = "mainline-missing-state";
    const runId = "story-run-001";
    const runPath = path.join(seriesRoot, seriesId, "runs", runId);
    let metadata = createRootSeriesMetadata({
      seriesId,
      createdAt: "2026-03-25T10:00:00.000Z",
    });
    metadata = appendSeriesRun(metadata, {
      runId,
      startedAt: "2026-03-25T10:00:00.000Z",
      finishedAt: "2026-03-25T10:01:00.000Z",
      turnCount: 3,
      chapterCount: 1,
      path: runPath,
      status: "success",
    });
    writeSeriesMetadata(seriesRoot, metadata);
    mkdirSync(path.join(runPath, "state"), { recursive: true });
    writeFileSync(path.join(runPath, "state", "consistency.json"), "[]\n", "utf8");

    try {
      const result = await runCli([
        `--series-root=${seriesRoot}`,
        `--series=${seriesId}`,
      ], { reject: false });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(runId);
      expect(result.stderr).toContain(path.join(runPath, "state", "final-world.json"));
    } finally {
      rmSync(seriesRoot, { recursive: true, force: true });
    }
  });
});

function runCli(
  args: string[],
  options: { reject?: boolean } = {},
) {
  return execa("node", ["--import", "tsx", cliPath, ...args], {
    cwd: repoRoot,
    reject: options.reject ?? true,
  });
}

function parseKeyValueOutput(stdout: string): Record<string, string> {
  const lines = stdout.trim().split("\n").filter(Boolean);
  return Object.fromEntries(lines.map((line) => {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex < 0) {
      return [line, ""];
    }
    return [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)];
  }));
}

function seedSeriesFixture(seriesRoot: string, seriesId: string) {
  const run1Path = path.join(seriesRoot, seriesId, "runs", "story-run-001");
  const run2Path = path.join(seriesRoot, seriesId, "runs", "story-run-002");
  const run3Path = path.join(seriesRoot, seriesId, "runs", "story-run-003");

  let metadata = createRootSeriesMetadata({
    seriesId,
    createdAt: "2026-03-25T10:00:00.000Z",
  });
  metadata = appendSeriesRun(metadata, {
    runId: "story-run-001",
    startedAt: "2026-03-25T10:00:00.000Z",
    finishedAt: "2026-03-25T10:05:00.000Z",
    turnCount: 3,
    chapterCount: 1,
    path: run1Path,
    status: "success",
  });
  metadata = appendSeriesRun(metadata, {
    runId: "story-run-002",
    startedAt: "2026-03-25T10:10:00.000Z",
    finishedAt: "2026-03-25T10:15:00.000Z",
    turnCount: 0,
    chapterCount: 0,
    path: run2Path,
    status: "failed",
    continuedFromRunId: "story-run-001",
  });
  metadata = appendSeriesRun(metadata, {
    runId: "story-run-003",
    startedAt: "2026-03-25T10:20:00.000Z",
    finishedAt: "2026-03-25T10:25:00.000Z",
    turnCount: 3,
    chapterCount: 1,
    path: run3Path,
    status: "success",
    continuedFromRunId: "story-run-001",
  });
  writeSeriesMetadata(seriesRoot, metadata);

  writeRunState(run1Path, {
    relations: [
      { relation: "ALLY_OF" },
      { relation: "EXECUTES" },
    ],
    projectedRelations: [
      { relation: "ALLY_OF" },
      { relation: "EXECUTES" },
    ],
    threadState: [{ threadId: "t-1" }],
    identities: [{ id: "i-1" }, { id: "i-2" }],
    consistencyIssues: [{ issue: "conflict-1" }],
  });

  writeRunState(run3Path, {
    relations: [{ relation: "ALLY_OF" }],
    projectedRelations: [{ relation: "ALLY_OF" }],
    threadState: [{ threadId: "t-1" }, { threadId: "t-2" }],
    identities: [{ id: "i-1" }, { id: "i-2" }, { id: "i-3" }],
    consistencyIssues: [],
  });
}

function writeRunState(
  runPath: string,
  input: {
    relations: Array<{ relation: string }>;
    projectedRelations: Array<{ relation: string }>;
    threadState: Array<{ threadId: string }>;
    identities: Array<{ id: string }>;
    consistencyIssues: unknown[];
  },
) {
  const stateDir = path.join(runPath, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, "final-world.json"), `${JSON.stringify({
    relations: input.relations,
    projectedRelations: input.projectedRelations,
    threadState: input.threadState,
    identities: input.identities,
  }, null, 2)}\n`, "utf8");
  writeFileSync(path.join(stateDir, "consistency.json"), `${JSON.stringify(input.consistencyIssues, null, 2)}\n`, "utf8");
}
