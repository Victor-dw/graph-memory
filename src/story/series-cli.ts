import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { closeDb, getDb } from "../store/db.ts";
import { buildRunId, readTurnsArg } from "./cli.ts";
import { loadStoryConfig } from "./config.ts";
import { writeRunBundle } from "./output/run-bundle.ts";
import { createStoryModelClient } from "./runtime/model-client.ts";
import { runStoryLoop } from "./runtime/run-loop.ts";
import { createStubStoryModelClient } from "./runtime/stub-model.ts";
import {
  deriveChildSeriesId,
  resolveSeriesMetadataPath,
  resolveSeriesPath,
  resolveSeriesRoot,
  resolveSeriesRunPath,
  resolveSeriesRunsPath,
} from "./series/layout.ts";
import {
  appendSeriesRun,
  countSuccessfulTurnsThroughRun,
  createBranchSeriesMetadata,
  createRootSeriesMetadata,
  readSeriesMetadata,
  writeSeriesMetadata,
} from "./series/metadata.ts";
import { restoreSeriesRun } from "./series/restore.ts";

type StorySeriesCliMode = "continue" | "branch";

export async function runStorySeriesCli(argv: string[] = process.argv.slice(2)) {
  const useStubModel = argv.includes("--stub-model");
  const cfg = loadStoryConfig({ allowMissingLlmEnv: useStubModel });
  const mode = readSeriesModeArg(argv);
  const seriesId = readRequiredArgValue(argv, "--series");
  const seriesRoot = resolveSeriesRoot(readOptionalArgValue(argv, "--series-root"));
  const turns = readTurnsArg(argv);
  const fromRunId = readOptionalArgValue(argv, "--from-run");

  rejectOutputDirArg(argv);
  if (mode === "branch" && !fromRunId) {
    throw new Error("[story-series] --mode=branch requires --from-run");
  }

  const model = useStubModel ? createStubStoryModelClient() : createStoryModelClient(cfg.llm);
  const startedAt = new Date().toISOString();
  const runId = buildRunId(startedAt);
  const mainlineExists = existsSync(resolveSeriesMetadataPath(seriesRoot, seriesId));

  let targetSeriesId = seriesId;
  let targetMetadata = mode === "continue"
    ? (mainlineExists
      ? readSeriesMetadata(seriesRoot, seriesId)
      : createRootSeriesMetadata({ seriesId, createdAt: startedAt }))
    : undefined;
  let restoreSeriesId = seriesId;
  let continuedFromRunId: string | null = null;
  let branchedFromRunId: string | null = null;
  let parentSeriesId: string | null = null;
  let resumeTurnNumber: number | undefined;
  let executionStarted = false;

  if (mode === "continue") {
    if (!targetMetadata) {
      throw new Error("[story-series] missing target metadata");
    }
    if (fromRunId && fromRunId !== targetMetadata.latestRunId) {
      throw new Error("[story-series] continue mode only accepts the latest successful run; use --mode=branch for earlier runs");
    }
    continuedFromRunId = targetMetadata.latestRunId;
    if (continuedFromRunId) {
      resumeTurnNumber = countSuccessfulTurnsThroughRun(targetMetadata, continuedFromRunId);
    }
  } else {
    if (!mainlineExists) {
      throw new Error(`[story-series] source series not found: ${seriesId}`);
    }
    const sourceMetadata = readSeriesMetadata(seriesRoot, seriesId);
    const sourceRun = sourceMetadata.runs.find((run) => run.runId === fromRunId);
    if (!sourceRun) {
      throw new Error(`[story-series] source run not found: ${fromRunId}`);
    }
    if (sourceRun.status !== "success") {
      throw new Error("[story-series] branch mode requires a successful source run");
    }

    parentSeriesId = seriesId;
    branchedFromRunId = fromRunId ?? null;
    continuedFromRunId = fromRunId ?? null;
    resumeTurnNumber = countSuccessfulTurnsThroughRun(sourceMetadata, fromRunId ?? "");
    restoreSeriesId = seriesId;
  }

  if (mode === "continue" && !targetMetadata) {
    throw new Error("[story-series] missing target metadata");
  }

  const db = getDb(cfg.dbPath);
  try {
    if (continuedFromRunId) {
      await restoreSeriesRun(db, {
        bundlePath: resolveSeriesRunPath(seriesRoot, restoreSeriesId, continuedFromRunId),
        resumeTurnNumber,
      });
    }

    if (mode === "branch") {
      targetSeriesId = reserveChildSeriesId(seriesRoot, seriesId);
      targetMetadata = createBranchSeriesMetadata({
        seriesId: targetSeriesId,
        parentSeriesId: seriesId,
        branchedFromRunId: fromRunId ?? "",
        createdAt: startedAt,
      });
    }
    if (!targetMetadata) {
      throw new Error("[story-series] missing target metadata");
    }

    executionStarted = true;
    const result = await withStoryResetDisabled(() => runStoryLoop(db, { turns, model }));
    const finishedAt = new Date().toISOString();
    const bundle = await writeRunBundle(db, result, {
      outputRoot: resolveSeriesRunsPath(seriesRoot, targetSeriesId),
      runMetadata: {
        runId,
        turns,
        chapterEveryTurns: cfg.chapterEveryTurns,
        dbPath: cfg.dbPath,
        resetOnStart: false,
        model: useStubModel
          ? { mode: "stub", name: "stub-story-model" }
          : { mode: cfg.llm.mode, name: cfg.llm.model },
        startedAt,
        finishedAt,
        seriesId: targetSeriesId,
        seriesMode: targetMetadata.mode,
        continuedFromRunId,
        branchedFromRunId,
        parentSeriesId,
      },
    });

    const successfulMetadata = appendSeriesRun(targetMetadata, {
      runId,
      startedAt,
      finishedAt,
      turnCount: bundle.turnCount,
      chapterCount: bundle.chapterCount,
      path: bundle.bundlePath,
      status: "success",
      continuedFromRunId,
    });
    writeSeriesMetadata(seriesRoot, successfulMetadata);
    targetMetadata = successfulMetadata;

    console.log(`series=${targetSeriesId}`);
    console.log(`mode=${mode}`);
    if (continuedFromRunId) {
      console.log(`continuedFromRunId=${continuedFromRunId}`);
    }
    if (branchedFromRunId) {
      console.log(`branchedFromRunId=${branchedFromRunId}`);
    }
    console.log(`turns=${bundle.turnCount}`);
    console.log(`chapters=${bundle.chapterCount}`);
    console.log(`bundle=${bundle.bundlePath}`);
    console.log(`latestRunId=${targetMetadata.latestRunId ?? ""}`);
    return result;
  } catch (error) {
    if (executionStarted) {
      if (!targetMetadata) {
        throw error;
      }
      const finishedAt = new Date().toISOString();
      targetMetadata = appendSeriesRun(targetMetadata, {
        runId,
        startedAt,
        finishedAt,
        turnCount: 0,
        chapterCount: 0,
        path: resolveSeriesRunPath(seriesRoot, targetSeriesId, runId),
        status: "failed",
        continuedFromRunId,
      });
      writeSeriesMetadata(seriesRoot, targetMetadata);
    }
    throw error;
  } finally {
    closeDb();
  }
}

if (import.meta.main) {
  runStorySeriesCli().catch((err) => {
    console.error("Story series CLI failed:", err);
    process.exit(1);
  });
}

function readSeriesModeArg(argv: string[]): StorySeriesCliMode {
  const rawMode = readOptionalArgValue(argv, "--mode");
  if (!rawMode) return "continue";
  if (rawMode === "continue" || rawMode === "branch") {
    return rawMode;
  }
  throw new Error("[story-series] --mode must be continue or branch");
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
    throw new Error(`[story-series] ${prefix} is required`);
  }
  return value;
}

function rejectOutputDirArg(argv: string[]): void {
  if (argv.some((entry) => entry.startsWith("--output-dir="))) {
    throw new Error("[story-series] --output-dir is not supported; use --series-root");
  }
}

function deriveNextChildOrdinal(seriesRoot: string, parentSeriesId: string): number {
  if (!existsSync(seriesRoot)) {
    return 1;
  }

  const prefix = `${parentSeriesId}-branch-`;
  const ordinals = readdirSync(seriesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => {
      const suffix = entry.name.slice(prefix.length);
      const parsed = Number(suffix);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
    })
    .filter((value) => value > 0);

  return (ordinals.length === 0 ? 0 : Math.max(...ordinals)) + 1;
}

function reserveChildSeriesId(seriesRoot: string, parentSeriesId: string): string {
  let ordinal = deriveNextChildOrdinal(seriesRoot, parentSeriesId);

  for (;;) {
    const candidate = deriveChildSeriesId(parentSeriesId, ordinal);
    try {
      mkdirSync(resolveSeriesPath(seriesRoot, candidate), { recursive: false });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        ordinal += 1;
        continue;
      }
      throw error;
    }
  }
}

async function withStoryResetDisabled<T>(fn: () => Promise<T>): Promise<T> {
  const previousResetOnStart = process.env.NOVEL_RESET_ON_START;
  process.env.NOVEL_RESET_ON_START = "0";
  try {
    return await fn();
  } finally {
    if (previousResetOnStart === undefined) {
      delete process.env.NOVEL_RESET_ON_START;
    } else {
      process.env.NOVEL_RESET_ON_START = previousResetOnStart;
    }
  }
}
