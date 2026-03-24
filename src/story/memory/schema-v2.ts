import { type DatabaseSyncInstance } from "@photostructure/sqlite";

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export interface StoryIdentityAlias {
  alias: string;
  aliasType: string;
  validFromTurn?: number;
  validToTurn?: number;
  isPrimaryPublic?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export interface StoryIdentityRecord {
  id: string;
  kind: "character" | "faction" | "location" | "artifact" | "thread" | "rule" | "technique" | "lineage";
  canonicalName: string;
  status: "active" | "hidden" | "destroyed" | "resolved";
  payloadJson: string;
  aliases?: StoryIdentityAlias[];
  createdAt?: number;
  updatedAt?: number;
}

const SAVEPOINT_NAME = "sp_story_identity";

export function insertStoryIdentity(db: DatabaseSyncInstance, record: StoryIdentityRecord): void {
  const now = record.updatedAt ?? Date.now();
  db.exec(`SAVEPOINT ${SAVEPOINT_NAME}`);
  try {
    db.prepare(`
      INSERT INTO story_identities (
        id, kind, canonical_name, status, payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        canonical_name = excluded.canonical_name,
        status = excluded.status,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(
      record.id,
      record.kind,
      record.canonicalName,
      record.status,
      record.payloadJson,
      record.createdAt ?? now,
      now,
    );

    if (record.aliases?.length) {
      const aliasStmt = db.prepare(`
        INSERT INTO story_identity_aliases (
          id, identity_id, alias, alias_type,
          valid_from_turn, valid_to_turn, is_primary_public,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(identity_id, alias, alias_type) DO UPDATE SET
          valid_from_turn = excluded.valid_from_turn,
          valid_to_turn = excluded.valid_to_turn,
          is_primary_public = excluded.is_primary_public,
          updated_at = excluded.updated_at
      `);

      for (const alias of record.aliases) {
        const aliasCreatedAt = alias.createdAt ?? now;
        const aliasUpdatedAt = alias.updatedAt ?? aliasCreatedAt;
        aliasStmt.run(
          generateId("sia"),
          record.id,
          alias.alias,
          alias.aliasType,
          alias.validFromTurn ?? null,
          alias.validToTurn ?? null,
          alias.isPrimaryPublic ? 1 : 0,
          aliasCreatedAt,
          aliasUpdatedAt,
        );
      }
    }

    db.exec(`RELEASE ${SAVEPOINT_NAME}`);
  } catch (error) {
    db.exec(`ROLLBACK TO ${SAVEPOINT_NAME}`);
    db.exec(`RELEASE ${SAVEPOINT_NAME}`);
    throw error;
  }
}
