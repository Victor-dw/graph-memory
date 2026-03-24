import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import type { StoryModelClient } from "../runtime/model-client.ts";
import type { StoryThread } from "../types.ts";

type StoryEntityRecord = {
  id: string;
  kind: string;
  name: string;
  payload: unknown;
};

type StoryRelationRecord = {
  id: string;
  fromId: string;
  relation: string;
  toId: string;
  visibility: string;
  intensity: number;
  sourceEventId?: string;
  validFromTurn?: number;
  createdAt: number;
  updatedAt: number;
};

type StoryNarrativeSignalRecord = {
  id: string;
  kind: string;
  subjectId: string;
  relatedId?: string;
  weight: number;
  status: string;
  payloadJson: string;
  createdAt: number;
  updatedAt: number;
};

type StoryChapterRecord = {
  id: string;
  turnNumber: number;
  claimsJson: string;
};

export interface StoryWorldSnapshot {
  entities: StoryEntityRecord[];
  relations: StoryRelationRecord[];
  activeThreads: StoryThread[];
  narrativeSignals: StoryNarrativeSignalRecord[];
}

export interface StoryClaim {
  subjectId: string;
  predicate: "OWNS" | "LOCATED_IN" | "ALLY_OF" | "ENEMY_OF" | "INJURED" | "DEAD";
  objectId?: string;
  valueText?: string;
  evidenceSpan: string;
}

export async function extractChapterClaims(
  model: StoryModelClient,
  prose: string,
): Promise<StoryClaim[]> {
  const claims = await model.extractClaims(prose);
  return claims
    .filter((claim): claim is StoryClaim => isStoryClaim(claim))
    .map((claim) => ({
      subjectId: claim.subjectId,
      predicate: claim.predicate,
      objectId: claim.objectId,
      valueText: claim.valueText,
      evidenceSpan: claim.evidenceSpan,
    }));
}

export function buildStoryWorldSnapshot(db: DatabaseSyncInstance): StoryWorldSnapshot {
  const projectedRelations = listAllProjectedRelations(db);
  return {
    entities: listAllStoryEntities(db),
    relations: projectedRelations.length > 0 ? projectedRelations : listAllStoryRelations(db),
    activeThreads: listTrackedThreads(db),
    narrativeSignals: listAllNarrativeSignals(db),
  };
}

export function validateChapterClaims(world: StoryWorldSnapshot, claims: StoryClaim[], asOfTurn?: number) {
  return claims.filter((claim) => contradictsWorld(world, claim, asOfTurn));
}

export function validateRecentChapters(db: DatabaseSyncInstance) {
  const world = buildStoryWorldSnapshot(db);
  const chapters = listRecentStoryChapters(db, 5);
  return chapters.flatMap((chapter) =>
    validateChapterClaims(world, parseClaimsJson(chapter.claimsJson), chapter.turnNumber)
  );
}

function contradictsWorld(world: StoryWorldSnapshot, claim: StoryClaim, asOfTurn?: number): boolean {
  const relationPredicates = new Set<StoryClaim["predicate"]>([
    "OWNS",
    "LOCATED_IN",
    "ALLY_OF",
    "ENEMY_OF",
  ]);
  if (!relationPredicates.has(claim.predicate) || !claim.objectId) {
    return false;
  }

  const known = world.relations.filter((relation) =>
    relation.fromId === claim.subjectId
      && relation.relation === claim.predicate
      && relationEffectiveAtTurn(relation, asOfTurn)
  );
  if (known.length === 0) {
    return false;
  }
  return known.every((relation) => relation.toId !== claim.objectId);
}

function relationEffectiveAtTurn(relation: StoryRelationRecord, asOfTurn?: number): boolean {
  if (typeof asOfTurn !== "number") return true;
  if (typeof relation.validFromTurn !== "number") return true;
  return relation.validFromTurn <= asOfTurn;
}

function listAllStoryEntities(db: DatabaseSyncInstance): StoryEntityRecord[] {
  const rows = db.prepare(`
    SELECT id, kind, name, payload
    FROM story_entities
    WHERE status = 'active'
    ORDER BY created_at ASC, id ASC
  `).all() as Array<{ id: string; kind: string; name: string; payload: string }>;
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    payload: parseJsonUnknown(row.payload),
  }));
}

function listAllStoryRelations(db: DatabaseSyncInstance): StoryRelationRecord[] {
  const rows = db.prepare(`
    SELECT id, from_id, relation, to_id, visibility, intensity, source_event_id, created_at, updated_at
    FROM story_relations
    ORDER BY created_at ASC, id ASC
  `).all() as Array<{
    id: string;
    from_id: string;
    relation: string;
    to_id: string;
    visibility: string;
    intensity: number;
    source_event_id: string | null;
    created_at: number;
    updated_at: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    fromId: row.from_id,
    relation: row.relation,
    toId: row.to_id,
    visibility: row.visibility,
    intensity: row.intensity,
    sourceEventId: row.source_event_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function listAllProjectedRelations(db: DatabaseSyncInstance): StoryRelationRecord[] {
  const rows = db.prepare(`
    SELECT
      id,
      from_identity_id,
      relation,
      to_identity_id,
      visibility,
      strength,
      derived_from_event_id,
      valid_from_turn,
      updated_at
    FROM story_state_relations
    ORDER BY updated_at ASC, id ASC
  `).all() as Array<{
    id: string;
    from_identity_id: string;
    relation: string;
    to_identity_id: string;
    visibility: string;
    strength: number;
    derived_from_event_id: string | null;
    valid_from_turn: number | null;
    updated_at: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    fromId: row.from_identity_id,
    relation: row.relation,
    toId: row.to_identity_id,
    visibility: row.visibility,
    intensity: row.strength,
    sourceEventId: row.derived_from_event_id ?? undefined,
    validFromTurn: row.valid_from_turn ?? undefined,
    createdAt: row.updated_at,
    updatedAt: row.updated_at,
  }));
}

function listTrackedThreads(db: DatabaseSyncInstance): StoryThread[] {
  const rows = db.prepare(`
    SELECT
      e.payload,
      ts.stage,
      ts.urgency,
      ts.pressure,
      ts.last_advanced_turn,
      ts.last_event_id
    FROM story_entities e
    LEFT JOIN story_thread_state ts ON ts.thread_id = e.id
    WHERE e.kind = 'thread' AND e.status = 'active'
    ORDER BY e.created_at ASC, e.id ASC
  `).all() as Array<{
    payload: string;
    stage: string | null;
    urgency: number | null;
    pressure: number | null;
    last_advanced_turn: number | null;
    last_event_id: string | null;
  }>;
  return rows.flatMap((row) => {
    const parsed = parseJsonUnknown(row.payload);
    if (
      parsed
      && typeof parsed === "object"
      && typeof (parsed as Partial<StoryThread>).id === "string"
      && typeof (parsed as Partial<StoryThread>).name === "string"
      && typeof (parsed as Partial<StoryThread>).status === "string"
    ) {
      const thread = parsed as StoryThread & Record<string, unknown>;
      if (row.stage) thread.stage = row.stage;
      if (typeof row.urgency === "number") thread.urgency = row.urgency;
      if (typeof row.pressure === "number") thread.pressure = row.pressure;
      if (typeof row.last_advanced_turn === "number") thread.lastAdvancedTurn = row.last_advanced_turn;
      if (row.last_event_id) thread.lastEventId = row.last_event_id;
      return [thread];
    }
    return [];
  });
}

function listAllNarrativeSignals(db: DatabaseSyncInstance): StoryNarrativeSignalRecord[] {
  const rows = db.prepare(`
    SELECT id, kind, subject_id, related_id, weight, status, payload_json, created_at, updated_at
    FROM story_narrative_signals
    WHERE status = 'active'
    ORDER BY updated_at DESC, id ASC
  `).all() as Array<{
    id: string;
    kind: string;
    subject_id: string;
    related_id: string | null;
    weight: number;
    status: string;
    payload_json: string;
    created_at: number;
    updated_at: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    subjectId: row.subject_id,
    relatedId: row.related_id ?? undefined,
    weight: row.weight,
    status: row.status,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function listRecentStoryChapters(db: DatabaseSyncInstance, limit: number): StoryChapterRecord[] {
  const rows = db.prepare(`
    SELECT id, turn_number, claims_json
    FROM story_chapters
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(limit) as Array<{ id: string; turn_number: number; claims_json: string }>;
  return rows.map((row) => ({
    id: row.id,
    turnNumber: row.turn_number,
    claimsJson: row.claims_json,
  }));
}

function parseClaimsJson(rawClaims: string): StoryClaim[] {
  const parsed = parseJsonUnknown(rawClaims);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((item): item is StoryClaim => isStoryClaim(item));
}

function isStoryClaim(value: unknown): value is StoryClaim {
  const validPredicates = new Set<StoryClaim["predicate"]>([
    "OWNS",
    "LOCATED_IN",
    "ALLY_OF",
    "ENEMY_OF",
    "INJURED",
    "DEAD",
  ]);
  return Boolean(
    value
      && typeof value === "object"
      && typeof (value as StoryClaim).subjectId === "string"
      && typeof (value as StoryClaim).predicate === "string"
      && validPredicates.has((value as StoryClaim).predicate)
      && typeof (value as StoryClaim).evidenceSpan === "string",
  );
}

function parseJsonUnknown(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
