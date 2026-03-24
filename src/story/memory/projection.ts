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

export function upsertProjectedRelation(
  db: DatabaseSyncInstance,
  record: ProjectedRelationRecord,
): void {
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
