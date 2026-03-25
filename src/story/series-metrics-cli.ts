import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readSeriesMetadata, type StorySeriesRunRecord } from "./series/metadata.ts";
import { resolveSeriesRunPath, resolveSeriesRoot } from "./series/layout.ts";

type MetricKey =
  | "relations"
  | "projectedRelations"
  | "threadState"
  | "identities"
  | "executes_in_projected"
  | "executes_in_legacy"
  | "consistency_issues";

const METRIC_KEYS: MetricKey[] = [
  "relations",
  "projectedRelations",
  "threadState",
  "identities",
  "executes_in_projected",
  "executes_in_legacy",
  "consistency_issues",
];

interface RunMetricSnapshot {
  runId: string;
  metrics: Record<MetricKey, number>;
}

interface StorySeriesMetricsReport {
  lines: string[];
  snapshots: RunMetricSnapshot[];
}

export function runStorySeriesMetricsCli(
  argv: string[] = process.argv.slice(2),
): StorySeriesMetricsReport {
  const seriesRoot = resolveSeriesRoot(readRequiredArgValue(argv, "--series-root"));
  const seriesId = readRequiredArgValue(argv, "--series");
  const metadata = readSeriesMetadata(seriesRoot, seriesId);
  const successfulRuns = metadata.runs.filter((run) => run.status === "success");

  if (successfulRuns.length === 0) {
    throw new Error(`[story-series-metrics] no successful runs found for series=${seriesId}`);
  }

  const snapshots = successfulRuns.map((run) =>
    readRunMetrics(seriesRoot, seriesId, run)
  );
  const first = snapshots[0];
  const latest = snapshots[snapshots.length - 1];
  if (!first || !latest) {
    throw new Error("[story-series-metrics] missing first/latest run metrics");
  }

  const lines: string[] = [
    `series=${seriesId}`,
    `seriesRoot=${seriesRoot}`,
    `successfulRunCount=${snapshots.length}`,
    `firstRunId=${first.runId}`,
    `latestRunId=${latest.runId}`,
  ];

  for (const metric of METRIC_KEYS) {
    lines.push(`first.${metric}=${first.metrics[metric]}`);
  }
  for (const metric of METRIC_KEYS) {
    lines.push(`latest.${metric}=${latest.metrics[metric]}`);
  }
  for (const metric of METRIC_KEYS) {
    const values = snapshots.map((snapshot) => snapshot.metrics[metric]);
    const total = values.reduce((sum, value) => sum + value, 0);
    lines.push(`all.${metric}.min=${Math.min(...values)}`);
    lines.push(`all.${metric}.max=${Math.max(...values)}`);
    lines.push(`all.${metric}.avg=${(total / values.length).toFixed(2)}`);
  }
  for (const metric of METRIC_KEYS) {
    const firstValue = first.metrics[metric];
    const latestValue = latest.metrics[metric];
    lines.push(`compare.first_vs_latest.${metric}.first=${firstValue}`);
    lines.push(`compare.first_vs_latest.${metric}.latest=${latestValue}`);
    lines.push(`compare.first_vs_latest.${metric}.delta=${latestValue - firstValue}`);
  }

  for (const line of lines) {
    console.log(line);
  }

  return { lines, snapshots };
}

if (import.meta.main) {
  try {
    runStorySeriesMetricsCli();
  } catch (error) {
    console.error("Story series metrics CLI failed:", toErrorMessage(error));
    process.exit(1);
  }
}

function readRunMetrics(
  seriesRoot: string,
  seriesId: string,
  run: StorySeriesRunRecord,
): RunMetricSnapshot {
  const bundlePath = resolveRunBundlePath(seriesRoot, seriesId, run);
  const worldPath = path.join(bundlePath, "state", "final-world.json");
  const consistencyPath = path.join(bundlePath, "state", "consistency.json");

  const world = parseJsonFile(
    worldPath,
    `run=${run.runId} final-world.json`,
  ) as Record<string, unknown>;
  const consistency = parseJsonFile(
    consistencyPath,
    `run=${run.runId} consistency.json`,
  );

  const relations = readRequiredArray(world, "relations", run.runId, worldPath);
  const projectedRelations = readOptionalArray(world, "projectedRelations", run.runId, worldPath);
  const threadState = readOptionalArray(world, "threadState", run.runId, worldPath);
  const identities = readOptionalArray(world, "identities", run.runId, worldPath);
  if (!Array.isArray(consistency)) {
    throw new Error(
      `[story-series-metrics] invalid consistency payload for run=${run.runId} at ${consistencyPath}; expected an array`,
    );
  }

  return {
    runId: run.runId,
    metrics: {
      relations: relations.length,
      projectedRelations: projectedRelations.length,
      threadState: threadState.length,
      identities: identities.length,
      executes_in_projected: countExecutes(projectedRelations),
      executes_in_legacy: countExecutes(relations),
      consistency_issues: consistency.length,
    },
  };
}

function resolveRunBundlePath(
  seriesRoot: string,
  seriesId: string,
  run: StorySeriesRunRecord,
): string {
  const recordedPath = path.isAbsolute(run.path)
    ? run.path
    : path.resolve(seriesRoot, run.path);
  if (existsSync(recordedPath)) {
    return recordedPath;
  }

  const derivedPath = resolveSeriesRunPath(seriesRoot, seriesId, run.runId);
  if (existsSync(derivedPath)) {
    return derivedPath;
  }

  throw new Error(
    `[story-series-metrics] run bundle path not found for run=${run.runId}; checked ${recordedPath} and ${derivedPath}`,
  );
}

function parseJsonFile(filePath: string, label: string): unknown {
  if (!existsSync(filePath)) {
    throw new Error(`[story-series-metrics] missing ${label} at ${filePath}`);
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`[story-series-metrics] invalid JSON in ${label} at ${filePath}`, {
      cause: error,
    });
  }
}

function readRequiredArray(
  source: Record<string, unknown>,
  key: string,
  runId: string,
  filePath: string,
): unknown[] {
  const value = source[key];
  if (!Array.isArray(value)) {
    throw new Error(
      `[story-series-metrics] invalid ${key} payload for run=${runId} at ${filePath}; expected an array`,
    );
  }
  return value;
}

function readOptionalArray(
  source: Record<string, unknown>,
  key: string,
  runId: string,
  filePath: string,
): unknown[] {
  const value = source[key];
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `[story-series-metrics] invalid ${key} payload for run=${runId} at ${filePath}; expected an array`,
    );
  }
  return value;
}

function countExecutes(relations: unknown[]): number {
  let count = 0;
  for (const relation of relations) {
    if (typeof relation !== "object" || relation === null) continue;
    const relationName = (relation as { relation?: unknown }).relation;
    if (typeof relationName !== "string") continue;
    if (relationName.toUpperCase() === "EXECUTES") {
      count += 1;
    }
  }
  return count;
}

function readRequiredArgValue(argv: string[], prefix: string): string {
  const arg = argv.find((entry) => entry.startsWith(`${prefix}=`));
  if (!arg) {
    throw new Error(`[story-series-metrics] ${prefix} is required`);
  }
  const value = arg.slice(`${prefix}=`.length).trim();
  if (!value) {
    throw new Error(`[story-series-metrics] ${prefix} is required`);
  }
  return value;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
