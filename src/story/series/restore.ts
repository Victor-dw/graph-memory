import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { restoreStorySnapshot, type StoryRestoreSnapshot } from "../world-state.ts";

export async function restoreSeriesRun(
  db: DatabaseSyncInstance,
  input: { bundlePath: string; resumeTurnNumber?: number },
): Promise<void> {
  const worldPath = path.join(input.bundlePath, "state", "final-world.json");
  const beliefsPath = path.join(input.bundlePath, "state", "final-beliefs.json");
  const directorPath = path.join(input.bundlePath, "state", "final-director.json");
  const world = readRequiredJson(worldPath, isValidWorldSnapshot);
  const beliefs = readRequiredJson(beliefsPath, (value) => Array.isArray(value));
  const director = readRequiredJson(directorPath, isValidDirectorSnapshot);

  restoreStorySnapshot(db, {
    world,
    beliefs,
    director,
    resumeTurnNumber: input.resumeTurnNumber,
  } as StoryRestoreSnapshot);
}

function readRequiredJson(
  filePath: string,
  validator: (value: unknown) => boolean,
): unknown {
  if (!existsSync(filePath)) {
    throw new Error(`[story-series] missing required snapshot: ${filePath}`);
  }

  const parsed = parseJsonFile(filePath);
  if (!validator(parsed)) {
    throw new Error(`[story-series] invalid snapshot shape: ${filePath}`);
  }
  return parsed;
}

function parseJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `[story-series] invalid snapshot JSON: ${filePath}`,
      { cause: error },
    );
  }
}

function isValidWorldSnapshot(value: unknown): boolean {
  return Boolean(
    value
    && typeof value === "object"
    && Array.isArray((value as { entities?: unknown[] }).entities)
    && Array.isArray((value as { relations?: unknown[] }).relations)
    && Array.isArray((value as { activeThreads?: unknown[] }).activeThreads)
    && Array.isArray((value as { narrativeSignals?: unknown[] }).narrativeSignals),
  );
}

function isValidDirectorSnapshot(value: unknown): boolean {
  return Boolean(value && typeof value === "object");
}
