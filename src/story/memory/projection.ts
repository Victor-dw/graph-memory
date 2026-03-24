import { type DatabaseSyncInstance } from "@photostructure/sqlite";

export interface ProjectedRelationRecord {
  id: string;
  fromIdentityId: string;
  relation: string;
  toIdentityId: string;
  visibility?: "public" | "private";
  strength?: number;
  derivedFromEventId?: string;
  validFromTurn?: number;
  updatedAt?: number;
}

const warnedProjectionSkips = new Set<string>();

export function upsertProjectedRelation(
  db: DatabaseSyncInstance,
  record: ProjectedRelationRecord,
): void {
  const unresolvedIdentityIds: string[] = [];
  if (!ensureIdentityExists(db, record.fromIdentityId)) {
    unresolvedIdentityIds.push(record.fromIdentityId);
  }
  if (!ensureIdentityExists(db, record.toIdentityId)) {
    unresolvedIdentityIds.push(record.toIdentityId);
  }
  if (unresolvedIdentityIds.length > 0) {
    warnProjectionSkipOnce(record, unresolvedIdentityIds);
    return;
  }
  const now = record.updatedAt ?? Date.now();
  db.prepare(`
    INSERT INTO story_state_relations (
      id, from_identity_id, relation, to_identity_id,
      visibility, strength, derived_from_event_id,
      valid_from_turn, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      from_identity_id = excluded.from_identity_id,
      relation = excluded.relation,
      to_identity_id = excluded.to_identity_id,
      visibility = excluded.visibility,
      strength = excluded.strength,
      derived_from_event_id = excluded.derived_from_event_id,
      valid_from_turn = excluded.valid_from_turn,
      updated_at = excluded.updated_at
  `).run(
    record.id,
    record.fromIdentityId,
    record.relation,
    record.toIdentityId,
    record.visibility ?? "public",
    record.strength ?? 1,
    record.derivedFromEventId ?? null,
    record.validFromTurn ?? null,
    now,
  );
}

function ensureIdentityExists(db: DatabaseSyncInstance, identityId: string): boolean {
  const existing = db.prepare("SELECT 1 FROM story_identities WHERE id = ?").get(identityId) as
    | { 1: number }
    | undefined;
  if (existing) {
    return true;
  }
  if (identityId.startsWith("conflict:")) {
    return createSyntheticConflictIdentity(db, identityId);
  }

  const legacyEntity = db.prepare(`
    SELECT kind, name, payload, status
    FROM story_entities
    WHERE id = ?
  `).get(identityId) as
    | { kind: string; name: string; payload: string; status: string }
    | undefined;
  if (!legacyEntity) {
    return false;
  }

  const now = Date.now();
  db.prepare(`
    INSERT INTO story_identities (
      id, kind, canonical_name, status, payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    identityId,
    legacyEntity.kind,
    legacyEntity.name,
    legacyEntity.status ?? "active",
    legacyEntity.payload,
    now,
    now,
  );
  return true;
}

function createSyntheticConflictIdentity(db: DatabaseSyncInstance, conflictId: string): boolean {
  const artifactId = conflictId.slice("conflict:".length) || "unknown-artifact";
  const now = Date.now();
  db.prepare(`
    INSERT INTO story_identities (
      id, kind, canonical_name, status, payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    conflictId,
    "thread",
    `Conflict over ${artifactId}`,
    "active",
    JSON.stringify({
      aggregateType: "artifact-conflict",
      artifactId,
    }),
    now,
    now,
  );
  return true;
}

function warnProjectionSkipOnce(record: ProjectedRelationRecord, unresolvedIdentityIds: string[]): void {
  const dedupeKey = `${record.id}|${unresolvedIdentityIds.join(",")}`;
  if (warnedProjectionSkips.has(dedupeKey)) {
    return;
  }
  warnedProjectionSkips.add(dedupeKey);
  console.warn(
    "[story-projection] skipped projected relation due to unresolved identity endpoints",
    {
      relation: record.relation,
      fromIdentityId: record.fromIdentityId,
      toIdentityId: record.toIdentityId,
      unresolvedIdentityIds,
    },
  );
}
