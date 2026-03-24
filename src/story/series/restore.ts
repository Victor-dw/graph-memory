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
  const beliefs = readRequiredJson(beliefsPath, isValidBeliefSnapshot);
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
  if (!isRecord(value)) {
    return false;
  }

  return Array.isArray(value.entities)
    && value.entities.every(isValidWorldEntityRecord)
    && Array.isArray(value.relations)
    && value.relations.every(isValidWorldRelationRecord)
    && Array.isArray(value.activeThreads)
    && value.activeThreads.every(isValidThreadRecord)
    && Array.isArray(value.narrativeSignals)
    && value.narrativeSignals.every(isValidNarrativeSignalRecord)
    && isOptionalArrayOf(value.identities, isValidIdentityRecord)
    && isOptionalArrayOf(value.projectedRelations, isValidProjectedRelationRecord)
    && isOptionalArrayOf(value.threadState, isValidThreadStateRecord);
}

function isValidDirectorSnapshot(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return Array.isArray(value.activeThreads)
    && value.activeThreads.every(isValidThreadRecord)
    && Array.isArray(value.unresolvedSecrets)
    && value.unresolvedSecrets.every(isValidNarrativeSignalRecord)
    && Array.isArray(value.activeTensions)
    && value.activeTensions.every(isValidNarrativeSignalRecord)
    && Array.isArray(value.payoffCandidates)
    && value.payoffCandidates.every(isValidNarrativeSignalRecord)
    && Array.isArray(value.ensembleHeat)
    && value.ensembleHeat.every(isValidEnsembleHeatEntry)
    && Array.isArray(value.recentPovIds)
    && value.recentPovIds.every((entry) => typeof entry === "string");
}

function isValidBeliefSnapshot(value: unknown): boolean {
  return Array.isArray(value) && value.every(isValidBeliefRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isValidWorldEntityRecord(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.kind === "string"
    && typeof value.name === "string"
    && isEntityPayloadRecord(value.payload);
}

function isEntityPayloadRecord(value: unknown): value is { id: string; name: string } {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.name === "string";
}

function isValidWorldRelationRecord(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.fromId === "string"
    && typeof value.relation === "string"
    && typeof value.toId === "string"
    && typeof value.visibility === "string"
    && typeof value.intensity === "number"
    && isOptionalString(value.sourceEventId)
    && isOptionalNumber(value.validFromTurn)
    && typeof value.createdAt === "number"
    && typeof value.updatedAt === "number";
}

function isValidThreadRecord(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && (value.status === "active" || value.status === "paused" || value.status === "resolved");
}

function isValidNarrativeSignalRecord(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.kind === "string"
    && typeof value.subjectId === "string"
    && isOptionalString(value.relatedId)
    && isOptionalNumber(value.weight)
    && typeof value.payloadJson === "string"
    && isOptionalString(value.status)
    && isOptionalNumber(value.createdAt)
    && isOptionalNumber(value.updatedAt);
}

function isValidEnsembleHeatEntry(value: unknown): boolean {
  return isRecord(value)
    && typeof value.entityId === "string"
    && typeof value.heat === "number";
}

function isValidBeliefRecord(value: unknown): boolean {
  return isRecord(value)
    && typeof value.actorId === "string"
    && typeof value.subjectId === "string"
    && typeof value.predicate === "string"
    && typeof value.objectId === "string"
    && typeof value.confidence === "number"
    && (value.actorKind === "character" || value.actorKind === "faction");
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === "number";
}

function isOptionalArrayOf(
  value: unknown,
  itemValidator: (entry: unknown) => boolean,
): boolean {
  return value === undefined || (Array.isArray(value) && value.every(itemValidator));
}

function isValidIdentityRecord(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.kind === "string"
    && typeof value.canonicalName === "string"
    && typeof value.status === "string"
    && typeof value.payloadJson === "string"
    && isOptionalArrayOf(value.aliases, isValidIdentityAliasRecord)
    && isOptionalNumber(value.createdAt)
    && isOptionalNumber(value.updatedAt);
}

function isValidIdentityAliasRecord(value: unknown): boolean {
  return isRecord(value)
    && typeof value.alias === "string"
    && typeof value.aliasType === "string"
    && isOptionalNumber(value.validFromTurn)
    && isOptionalNumber(value.validToTurn)
    && (value.isPrimaryPublic === undefined || typeof value.isPrimaryPublic === "boolean")
    && isOptionalNumber(value.createdAt)
    && isOptionalNumber(value.updatedAt);
}

function isValidProjectedRelationRecord(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.fromIdentityId === "string"
    && typeof value.relation === "string"
    && typeof value.toIdentityId === "string"
    && typeof value.visibility === "string"
    && typeof value.strength === "number"
    && isOptionalString(value.derivedFromEventId)
    && isOptionalNumber(value.validFromTurn)
    && typeof value.updatedAt === "number";
}

function isValidThreadStateRecord(value: unknown): boolean {
  return isRecord(value)
    && typeof value.threadId === "string"
    && typeof value.stage === "string"
    && typeof value.urgency === "number"
    && typeof value.pressure === "number"
    && isOptionalString(value.focusIdentityId)
    && isOptionalNumber(value.lastAdvancedTurn)
    && isOptionalString(value.lastEventId)
    && typeof value.blockingFactorsJson === "string"
    && typeof value.pendingPayoffsJson === "string"
    && isOptionalNumber(value.updatedAt);
}
