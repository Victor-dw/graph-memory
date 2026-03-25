import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readTurnsArg } from "./cli.ts";
import { loadStoryConfig } from "./config.ts";
import { readBundleMetrics, type StoryRunBundleMetrics } from "./output/bundle-metrics.ts";
import { runStorySeriesCli } from "./series-cli.ts";
import { readSeriesMetadata } from "./series/metadata.ts";
import { resolveSeriesRoot } from "./series/layout.ts";

const DEFAULT_DURATION_HOURS = 24;
const DEFAULT_COOLDOWN_SECONDS = 0;
const MINIMAX_BASE_URL = "https://api.minimaxi.com/anthropic";
const MINIMAX_MODEL = "MiniMax-M2.7";

interface StoryLongRunSessionSummary {
  label: string;
  status: "running" | "completed" | "stopped" | "failed";
  seriesId: string;
  seriesRoot: string;
  controlDir: string;
  summaryPath: string;
  eventsPath: string;
  stopFilePath: string;
  startedAt: string;
  updatedAt: string;
  deadlineAt: string;
  turnsPerRun: number;
  durationHours: number;
  maxRuns: number | null;
  cooldownSeconds: number;
  modelMode: string;
  modelName: string;
  completedRuns: number;
  failedRuns: number;
  lastRunId: string | null;
  lastBundlePath: string | null;
  lastRunMetrics: StoryRunBundleMetrics | null;
  metricsUnavailable: boolean;
  lastRunMetricsWarning: string | null;
  failureMessage: string | null;
}

interface LongRunDependencies {
  now(): Date;
  sleep(ms: number): Promise<void>;
  runSeries(argv: string[]): Promise<unknown>;
}

const defaultDeps: LongRunDependencies = {
  now: () => new Date(),
  sleep: async (ms) => {
    if (ms <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, ms));
  },
  runSeries: (argv) => runStorySeriesCli(argv),
};

export async function runStoryLongRunCli(
  argv: string[] = process.argv.slice(2),
  deps: Partial<LongRunDependencies> = {},
): Promise<StoryLongRunSessionSummary> {
  const runtime = { ...defaultDeps, ...deps };
  const useStubModel = argv.includes("--stub-model");
  const cfg = loadStoryConfig({ allowMissingLlmEnv: useStubModel });
  if (!useStubModel) {
    assertMiniMaxRuntime(cfg.llm);
  }

  const seriesId = readRequiredArgValue(argv, "--series");
  const seriesRoot = resolveSeriesRoot(readOptionalArgValue(argv, "--series-root"));
  const turns = readTurnsArg(argv);
  const durationHours = readPositiveNumberArg(argv, "--duration-hours", DEFAULT_DURATION_HOURS);
  const maxRuns = readOptionalPositiveIntegerArg(argv, "--max-runs");
  const cooldownSeconds = readNonNegativeIntegerArg(argv, "--cooldown-seconds", DEFAULT_COOLDOWN_SECONDS);
  const startedAt = runtime.now().toISOString();
  const label = readOptionalArgValue(argv, "--label") ?? buildSessionLabel(seriesId, startedAt);
  const controlDir = readControlDirArg(argv, seriesRoot, label);
  const summaryPath = path.join(controlDir, "summary.json");
  const eventsPath = path.join(controlDir, "events.jsonl");
  const stopFilePath = path.join(controlDir, "STOP");
  const deadlineAt = new Date(runtime.now().getTime() + durationHours * 60 * 60 * 1000).toISOString();

  mkdirSync(controlDir, { recursive: true });

  const summary: StoryLongRunSessionSummary = {
    label,
    status: "running",
    seriesId,
    seriesRoot,
    controlDir,
    summaryPath,
    eventsPath,
    stopFilePath,
    startedAt,
    updatedAt: startedAt,
    deadlineAt,
    turnsPerRun: turns,
    durationHours,
    maxRuns: maxRuns ?? null,
    cooldownSeconds,
    modelMode: cfg.llm.mode,
    modelName: cfg.llm.model,
    completedRuns: 0,
    failedRuns: 0,
    lastRunId: null,
    lastBundlePath: null,
    lastRunMetrics: null,
    metricsUnavailable: false,
    lastRunMetricsWarning: null,
    failureMessage: null,
  };
  writeSummary(summary);
  appendEvent(eventsPath, {
    type: "session-started",
    at: startedAt,
    label,
    seriesId,
    deadlineAt,
    turns,
  });

  try {
    for (;;) {
      const currentTime = runtime.now().toISOString();
      summary.updatedAt = currentTime;
      writeSummary(summary);

      if (existsSync(stopFilePath)) {
        summary.status = "stopped";
        appendEvent(eventsPath, {
          type: "session-stopped",
          at: currentTime,
          completedRuns: summary.completedRuns,
          reason: "stop-file",
        });
        break;
      }

      if (maxRuns !== undefined && summary.completedRuns >= maxRuns) {
        summary.status = "completed";
        appendEvent(eventsPath, {
          type: "session-completed",
          at: currentTime,
          completedRuns: summary.completedRuns,
          reason: "max-runs",
        });
        break;
      }

      if (runtime.now().toISOString() >= deadlineAt) {
        summary.status = "completed";
        appendEvent(eventsPath, {
          type: "session-completed",
          at: currentTime,
          completedRuns: summary.completedRuns,
          reason: "deadline",
        });
        break;
      }

      appendEvent(eventsPath, {
        type: "run-started",
        at: currentTime,
        nextRunNumber: summary.completedRuns + 1,
      });

      try {
        await runtime.runSeries(buildSeriesArgv(argv, seriesId, seriesRoot, turns));
      } catch (error) {
        summary.failedRuns += 1;
        summary.failureMessage = error instanceof Error ? error.message : String(error);
        summary.updatedAt = runtime.now().toISOString();
        writeSummary(summary);
        appendEvent(eventsPath, {
          type: "run-failed",
          at: summary.updatedAt,
          failedRuns: summary.failedRuns,
          message: summary.failureMessage,
        });
        if (cooldownSeconds > 0 && shouldWaitForNextIteration(summary, stopFilePath, maxRuns, deadlineAt, runtime.now())) {
          await runtime.sleep(cooldownSeconds * 1000);
        }
        continue;
      }

      const metadata = readSeriesMetadata(seriesRoot, seriesId);
      const latestRun = findRunById(metadata.runs, metadata.latestRunId);
      if (!latestRun || latestRun.status !== "success") {
        throw new Error("[story-long-run] latest successful run metadata missing after story:series execution");
      }

      summary.completedRuns += 1;
      summary.lastRunId = latestRun.runId;
      summary.lastBundlePath = latestRun.path ?? null;
      const metricsResult = collectBundleMetrics(latestRun.path);
      if (metricsResult.metricsUnavailable) {
        summary.lastRunMetrics = null;
        summary.metricsUnavailable = true;
        summary.lastRunMetricsWarning = metricsResult.warning;
      } else {
        summary.lastRunMetrics = metricsResult.bundleMetrics;
        summary.metricsUnavailable = false;
        summary.lastRunMetricsWarning = null;
      }
      summary.updatedAt = runtime.now().toISOString();
      writeSummary(summary);
      appendEvent(eventsPath, {
        type: "run-succeeded",
        at: summary.updatedAt,
        completedRuns: summary.completedRuns,
        latestRunId: latestRun.runId,
        latestBundlePath: latestRun.path,
        bundleMetrics: metricsResult.metricsUnavailable ? undefined : metricsResult.bundleMetrics,
        metricsUnavailable: metricsResult.metricsUnavailable || undefined,
        warning: metricsResult.metricsUnavailable ? metricsResult.warning : undefined,
      });

      if (cooldownSeconds > 0 && shouldWaitForNextIteration(summary, stopFilePath, maxRuns, deadlineAt, runtime.now())) {
        await runtime.sleep(cooldownSeconds * 1000);
      }
    }
  } finally {
    summary.updatedAt = runtime.now().toISOString();
    if (summary.status === "running") {
      summary.status = "completed";
    }
    writeSummary(summary);
  }

  console.log(`label=${summary.label}`);
  console.log(`status=${summary.status}`);
  console.log(`completedRuns=${summary.completedRuns}`);
  console.log(`failedRuns=${summary.failedRuns}`);
  console.log(`stopFile=${summary.stopFilePath}`);
  console.log(`summary=${summary.summaryPath}`);
  if (summary.lastRunId) {
    console.log(`latestRunId=${summary.lastRunId}`);
  }

  return summary;
}

if (import.meta.main) {
  runStoryLongRunCli().catch((err) => {
    console.error("Story long-run CLI failed:", err);
    process.exit(1);
  });
}

function buildSeriesArgv(argv: string[], seriesId: string, seriesRoot: string, turns: number): string[] {
  const forwardableArgs = argv.filter((arg) =>
    arg === "--stub-model"
    || arg.startsWith("--series=")
    || arg.startsWith("--series-root=")
    || arg.startsWith("--turns="),
  );
  const withoutConflicts = forwardableArgs.filter((arg) =>
    !arg.startsWith("--series=") && !arg.startsWith("--series-root=") && !arg.startsWith("--turns="),
  );
  return [
    `--series=${seriesId}`,
    `--series-root=${seriesRoot}`,
    `--turns=${turns}`,
    ...withoutConflicts,
  ];
}

function buildSessionLabel(seriesId: string, startedAt: string): string {
  return `${seriesId}-${startedAt.replace(/[:.]/g, "-")}`;
}

function readControlDirArg(argv: string[], seriesRoot: string, label: string): string {
  const raw = readOptionalArgValue(argv, "--control-dir");
  const root = raw ? path.resolve(process.cwd(), raw) : path.join(seriesRoot, ".long-run");
  return path.join(root, label);
}

function readOptionalArgValue(argv: string[], prefix: string): string | undefined {
  const arg = argv.find((entry) => entry.startsWith(`${prefix}=`));
  if (!arg) return undefined;
  const value = arg.slice(`${prefix}=`.length).trim();
  return value || undefined;
}

function readRequiredArgValue(argv: string[], prefix: string): string {
  const value = readOptionalArgValue(argv, prefix);
  if (!value) {
    throw new Error(`[story-long-run] ${prefix} is required`);
  }
  return value;
}

function readOptionalPositiveIntegerArg(argv: string[], prefix: string): number | undefined {
  const raw = readOptionalArgValue(argv, prefix);
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`[story-long-run] ${prefix} must be a positive integer`);
  }
  return parsed;
}

function readNonNegativeIntegerArg(argv: string[], prefix: string, fallback: number): number {
  const raw = readOptionalArgValue(argv, prefix);
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`[story-long-run] ${prefix} must be a non-negative integer`);
  }
  return parsed;
}

function readPositiveNumberArg(argv: string[], prefix: string, fallback: number): number {
  const raw = readOptionalArgValue(argv, prefix);
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`[story-long-run] ${prefix} must be a positive number`);
  }
  return parsed;
}

function assertMiniMaxRuntime(llm: {
  mode: string;
  baseURL: string;
  model: string;
  apiKey: string;
}): void {
  if (llm.mode !== "anthropic-compatible") {
    throw new Error("[story-long-run] NOVEL_LLM_MODE must stay anthropic-compatible for MiniMax runs");
  }
  if (llm.baseURL.replace(/\/+$/, "") !== MINIMAX_BASE_URL) {
    throw new Error(`[story-long-run] NOVEL_LLM_BASE_URL must be ${MINIMAX_BASE_URL} for MiniMax runs`);
  }
  if (llm.model !== MINIMAX_MODEL) {
    throw new Error(`[story-long-run] NOVEL_LLM_MODEL must be ${MINIMAX_MODEL} for MiniMax runs`);
  }
  if (!llm.apiKey.trim()) {
    throw new Error("[story-long-run] NOVEL_LLM_API_KEY is required for MiniMax runs");
  }
}

function writeSummary(summary: StoryLongRunSessionSummary): void {
  writeFileSync(summary.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

function appendEvent(eventsPath: string, event: Record<string, unknown>): void {
  appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
}

function findRunById(
  runs: Array<{ runId: string; status?: string; path?: string }>,
  runId: string | null,
): { runId: string; status?: string; path?: string } | undefined {
  if (!runId) {
    return undefined;
  }
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (run?.runId === runId) {
      return run;
    }
  }
  return undefined;
}

function collectBundleMetrics(
  bundlePath: string | undefined,
): ReturnType<typeof readBundleMetrics> {
  if (!bundlePath) {
    return {
      metricsUnavailable: true,
      warning: "[story-long-run] latest run bundle path missing in series metadata",
    };
  }
  return readBundleMetrics(bundlePath);
}

function shouldWaitForNextIteration(
  summary: Pick<StoryLongRunSessionSummary, "completedRuns">,
  stopFilePath: string,
  maxRuns: number | undefined,
  deadlineAt: string,
  now: Date,
): boolean {
  if (existsSync(stopFilePath)) {
    return false;
  }
  if (maxRuns !== undefined && summary.completedRuns >= maxRuns) {
    return false;
  }
  return now.toISOString() < deadlineAt;
}
