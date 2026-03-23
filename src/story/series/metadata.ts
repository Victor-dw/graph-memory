import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { assertSafePathSegment, resolveSeriesMetadataPath, resolveSeriesPath } from "./layout.ts";

export type StorySeriesType = "mainline" | "alternate";
export type StorySeriesMode = "root" | "branch";
export type StorySeriesRunStatus = "running" | "success" | "failed";

export interface StorySeriesRunRecord {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  turnCount: number;
  chapterCount: number;
  path: string;
  status: StorySeriesRunStatus;
  seriesChapterStart?: number;
  seriesChapterEnd?: number;
  continuedFromRunId?: string | null;
}

export interface StorySeriesMetadata {
  schemaVersion: 1;
  seriesId: string;
  type: StorySeriesType;
  mode: StorySeriesMode;
  createdAt: string;
  updatedAt: string;
  parentSeriesId?: string;
  branchedFromRunId?: string;
  latestRunId: string | null;
  runCount: number;
  totalChapterCount: number;
  runs: StorySeriesRunRecord[];
}

export interface CreateRootSeriesMetadataInput {
  seriesId: string;
  createdAt: string;
}

export interface CreateBranchSeriesMetadataInput extends CreateRootSeriesMetadataInput {
  parentSeriesId: string;
  branchedFromRunId: string;
}

export interface AppendSeriesRunInput {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  turnCount: number;
  chapterCount: number;
  path: string;
  status: StorySeriesRunStatus;
  continuedFromRunId?: string | null;
}

export function createRootSeriesMetadata(
  input: CreateRootSeriesMetadataInput,
): StorySeriesMetadata {
  assertSafePathSegment(input.seriesId);
  return {
    schemaVersion: 1,
    seriesId: input.seriesId,
    type: "mainline",
    mode: "root",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    latestRunId: null,
    runCount: 0,
    totalChapterCount: 0,
    runs: [],
  };
}

export function createBranchSeriesMetadata(
  input: CreateBranchSeriesMetadataInput,
): StorySeriesMetadata {
  assertSafePathSegment(input.parentSeriesId);
  return {
    ...createRootSeriesMetadata(input),
    type: "alternate",
    mode: "branch",
    parentSeriesId: input.parentSeriesId,
    branchedFromRunId: input.branchedFromRunId,
  };
}

export function appendSeriesRun(
  metadata: StorySeriesMetadata,
  input: AppendSeriesRunInput,
): StorySeriesMetadata {
  assertSafePathSegment(metadata.seriesId);
  assertSafePathSegment(input.runId);
  assertNonNegativeInteger(input.turnCount, "turnCount");
  assertNonNegativeInteger(input.chapterCount, "chapterCount");
  if (metadata.runs.some((run) => run.runId === input.runId)) {
    throw new Error("[story-series] duplicate runId");
  }
  if (input.status !== "running" && !input.finishedAt) {
    throw new Error("[story-series] finishedAt is required for terminal runs");
  }

  const isSuccessful = input.status === "success";
  const nextTotalChapterCount = metadata.totalChapterCount + (isSuccessful ? input.chapterCount : 0);
  const seriesChapterStart = isSuccessful && input.chapterCount > 0
    ? metadata.totalChapterCount + 1
    : undefined;
  const seriesChapterEnd = seriesChapterStart === undefined
    ? undefined
    : seriesChapterStart + input.chapterCount - 1;
  const runRecord: StorySeriesRunRecord = {
    runId: input.runId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    turnCount: input.turnCount,
    chapterCount: input.chapterCount,
    path: input.path,
    status: input.status,
    continuedFromRunId: input.continuedFromRunId,
    seriesChapterStart,
    seriesChapterEnd,
  };

  return {
    ...metadata,
    updatedAt: input.finishedAt ?? input.startedAt,
    latestRunId: isSuccessful ? input.runId : metadata.latestRunId,
    runCount: metadata.runCount + 1,
    totalChapterCount: nextTotalChapterCount,
    runs: [...metadata.runs, runRecord],
  };
}

export function readSeriesMetadata(
  seriesRoot: string,
  seriesId: string,
): StorySeriesMetadata {
  const metadataPath = resolveSeriesMetadataPath(seriesRoot, seriesId);
  if (!existsSync(metadataPath)) {
    throw new Error(`[story-series] missing metadata for series=${seriesId}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(metadataPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error("[story-series] invalid series metadata", { cause: error });
  }

  return parseSeriesMetadata(parsed);
}

export function writeSeriesMetadata(
  seriesRoot: string,
  metadata: StorySeriesMetadata,
): void {
  assertValidSeriesMetadata(metadata);
  const seriesPath = resolveSeriesPath(seriesRoot, metadata.seriesId);
  mkdirSync(seriesPath, { recursive: true });
  writeFileSync(
    resolveSeriesMetadataPath(seriesRoot, metadata.seriesId),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
}

export function countSuccessfulTurnsThroughRun(
  metadata: StorySeriesMetadata,
  runId: string,
): number {
  let totalTurns = 0;
  for (const run of metadata.runs) {
    if (run.status === "success") {
      totalTurns += run.turnCount;
    }
    if (run.runId === runId) {
      if (run.status !== "success") {
        throw new Error("[story-series] source run must be successful to derive continuation turns");
      }
      return totalTurns;
    }
  }

  throw new Error(`[story-series] run not found in series metadata: ${runId}`);
}

function parseSeriesMetadata(value: unknown): StorySeriesMetadata {
  assertValidSeriesMetadata(value);
  return value;
}

function assertValidSeriesMetadata(value: unknown): asserts value is StorySeriesMetadata {
  if (!value || typeof value !== "object") {
    throw new Error("[story-series] invalid series metadata");
  }

  const metadata = value as Partial<StorySeriesMetadata>;
  assertSafePathSegment(requireString(metadata.seriesId));
  if (metadata.schemaVersion !== 1) {
    throw new Error("[story-series] invalid series metadata");
  }
  if (metadata.type !== "mainline" && metadata.type !== "alternate") {
    throw new Error("[story-series] invalid series metadata");
  }
  if (metadata.mode !== "root" && metadata.mode !== "branch") {
    throw new Error("[story-series] invalid series metadata");
  }
  requireString(metadata.createdAt);
  requireString(metadata.updatedAt);
  if (metadata.parentSeriesId !== undefined) {
    assertSafePathSegment(requireString(metadata.parentSeriesId));
  }
  if (metadata.branchedFromRunId !== undefined) {
    assertSafePathSegment(requireString(metadata.branchedFromRunId));
  }
  if (metadata.latestRunId !== null && metadata.latestRunId !== undefined) {
    assertSafePathSegment(requireString(metadata.latestRunId));
  }
  assertNonNegativeInteger(metadata.runCount, "runCount");
  assertNonNegativeInteger(metadata.totalChapterCount, "totalChapterCount");
  if (!Array.isArray(metadata.runs)) {
    throw new Error("[story-series] invalid series metadata");
  }
  if (metadata.runCount !== metadata.runs.length) {
    throw new Error("[story-series] invalid series metadata");
  }

  const runIds = new Set<string>();
  let successfulRunIdSeen = metadata.latestRunId === null;
  let lastSuccessfulRunId: string | null = null;
  for (const run of metadata.runs) {
    assertValidRunRecord(run);
    if (runIds.has(run.runId)) {
      throw new Error("[story-series] invalid series metadata");
    }
    runIds.add(run.runId);
    if (run.status === "success") {
      lastSuccessfulRunId = run.runId;
      if (run.runId === metadata.latestRunId) {
        successfulRunIdSeen = true;
      }
    }
  }

  if (!successfulRunIdSeen || metadata.latestRunId !== lastSuccessfulRunId) {
    throw new Error("[story-series] invalid series metadata");
  }
}

function assertValidRunRecord(value: unknown): asserts value is StorySeriesRunRecord {
  if (!value || typeof value !== "object") {
    throw new Error("[story-series] invalid series metadata");
  }

  const run = value as Partial<StorySeriesRunRecord>;
  assertSafePathSegment(requireString(run.runId));
  requireString(run.startedAt);
  if (run.finishedAt !== undefined) {
    requireString(run.finishedAt);
  }
  assertNonNegativeInteger(run.turnCount, "turnCount");
  assertNonNegativeInteger(run.chapterCount, "chapterCount");
  requireString(run.path);
  if (run.status !== "running" && run.status !== "success" && run.status !== "failed") {
    throw new Error("[story-series] invalid series metadata");
  }
  if (run.status !== "running" && run.finishedAt === undefined) {
    throw new Error("[story-series] invalid series metadata");
  }
  if (run.continuedFromRunId !== undefined && run.continuedFromRunId !== null) {
    assertSafePathSegment(requireString(run.continuedFromRunId));
  }
  if (run.seriesChapterStart !== undefined) {
    assertNonNegativeInteger(run.seriesChapterStart, "seriesChapterStart");
  }
  if (run.seriesChapterEnd !== undefined) {
    assertNonNegativeInteger(run.seriesChapterEnd, "seriesChapterEnd");
  }
}

function requireString(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("[story-series] invalid series metadata");
  }
  return value;
}

function assertNonNegativeInteger(value: unknown, fieldName: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`[story-series] ${fieldName} must be a non-negative integer`);
  }
}
