import { describe, expect, it } from "vitest";
import { createTestDb } from "../helpers.ts";
import { closeDb, getDb } from "../../src/store/db.ts";
import {
  appendStoryLedgerEvent,
  getThreadState,
  insertStoryIdentity,
  upsertProjectedRelation,
  upsertThreadState,
} from "../../src/store/store.ts";
import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("story schema v2 store helpers", () => {
  it("persists canonical identities and alias references", () => {
    const db = createTestDb();

    insertStoryIdentity(db, {
      id: "c-su-wan",
      kind: "character",
      canonicalName: "Su Wan",
      status: "active",
      payloadJson: JSON.stringify({ publicIdentity: "quiet disciple" }),
      aliases: [
        {
          alias: "quiet disciple",
          aliasType: "public-title",
          validFromTurn: 1,
          isPrimaryPublic: true,
        },
      ],
    });

    const identityRow = db
      .prepare("SELECT canonical_name FROM story_identities WHERE id=?")
      .get("c-su-wan");
    expect(identityRow).toBeDefined();

    const aliasRow = db
      .prepare(
        "SELECT alias, alias_type, is_primary_public, identity_id FROM story_identity_aliases WHERE identity_id=?",
      )
      .get("c-su-wan");
    expect(aliasRow?.alias).toBe("quiet disciple");
    expect(aliasRow?.alias_type).toBe("public-title");
    expect(aliasRow?.is_primary_public).toBe(1);
    expect(aliasRow?.identity_id).toBe("c-su-wan");
  });

  it("keeps identity aliases unique when re-inserting the same identity", () => {
    const db = createTestDb();
    const canonical = {
      id: "c-su-wan",
      kind: "character",
      canonicalName: "Su Wan",
      status: "active",
      payloadJson: JSON.stringify({ publicIdentity: "quiet disciple" }),
      aliases: [
        {
          alias: "quiet disciple",
          aliasType: "public-title",
          validFromTurn: 1,
          isPrimaryPublic: true,
        },
      ],
    };

    insertStoryIdentity(db, canonical);
    insertStoryIdentity(db, { ...canonical, canonicalName: "Su Wan, unresolved" });

    const aliasRows = db
      .prepare("SELECT identity_id, alias, alias_type FROM story_identity_aliases WHERE identity_id = ?")
      .all("c-su-wan");

    expect(aliasRows).toHaveLength(1);
    expect(aliasRows[0].identity_id).toBe("c-su-wan");
    expect(aliasRows[0].alias).toBe("quiet disciple");
  });

  it("appends ledger events", () => {
    const db = createTestDb();

    appendStoryLedgerEvent(db, {
      id: "sle-1",
      turnNumber: 1,
      eventType: "artifact-showdown",
      eventPhase: "resolution",
      summary: "The Ember Seal contest breaks into the open.",
      visibility: "public",
      payloadJson: JSON.stringify({ artifactId: "a-ember-seal" }),
    });

    const eventRow = db
      .prepare("SELECT event_type FROM story_event_ledger WHERE id=?")
      .get("sle-1");
    expect(eventRow).toBeDefined();
  });

  it("allows exact ledger event replays without error", () => {
    const db = createTestDb();
    const event = {
      id: "sle-replay",
      turnNumber: 1,
      eventType: "artifact-contested",
      eventPhase: "resolution",
      summary: "The artifact contest is broadcast.",
      visibility: "public" as const,
      payloadJson: JSON.stringify({ artifactId: "a-ember-seal" }),
    };

    appendStoryLedgerEvent(db, event);
    expect(() => appendStoryLedgerEvent(db, { ...event })).not.toThrow();

    const count = (db
      .prepare("SELECT COUNT(*) AS c FROM story_event_ledger WHERE id=?")
      .get(event.id) as { c: number }).c;
    expect(count).toBe(1);
  });

  it("allows semantically identical ledger JSON replays", () => {
    const db = createTestDb();
    const event = {
      id: "sle-normalize",
      turnNumber: 2,
      eventType: "artifact-showdown",
      eventPhase: "resolution",
      summary: "Normalization test",
      visibility: "public" as const,
      payloadJson: JSON.stringify({ a: 1, b: 2 }),
    };

    appendStoryLedgerEvent(db, event);

    const reordered = {
      ...event,
      payloadJson: JSON.stringify({ b: 2, a: 1 }),
    };
    expect(() => appendStoryLedgerEvent(db, reordered)).not.toThrow();

    const count = (db
      .prepare("SELECT COUNT(*) AS c FROM story_event_ledger WHERE id=?")
      .get(event.id) as { c: number }).c;
    expect(count).toBe(1);
  });

  it("throws when ledger event replay conflicts with different data", () => {
    const db = createTestDb();
    const event = {
      id: "sle-conflict",
      turnNumber: 1,
      eventType: "artifact-contested",
      eventPhase: "resolution",
      summary: "A conflict occurs in the Lotus Court.",
      visibility: "public" as const,
      payloadJson: JSON.stringify({ artifactId: "a-ember-seal" }),
    };

    appendStoryLedgerEvent(db, event);
    expect(() =>
      appendStoryLedgerEvent(db, {
        ...event,
        summary: "A different description",
      }),
    ).toThrow("Conflicting story ledger event sle-conflict");
  });

  it("upserts projected relations and respects conflicts", () => {
    const db = createTestDb();

    insertStoryIdentity(db, {
      id: "c-su-wan",
      kind: "character",
      canonicalName: "Su Wan",
      status: "active",
      payloadJson: JSON.stringify({ publicIdentity: "quiet disciple" }),
    });

    insertStoryIdentity(db, {
      id: "c-li-yao",
      kind: "character",
      canonicalName: "Li Yao",
      status: "active",
      payloadJson: JSON.stringify({ publicIdentity: "rival" }),
    });

    upsertProjectedRelation(db, {
      id: "rel-1",
      fromIdentityId: "c-su-wan",
      relation: "ALLY_OF",
      toIdentityId: "c-li-yao",
      visibility: "public",
      strength: 0.8,
      derivedFromEventId: "sle-1",
      validFromTurn: 1,
    });

    let relationRow = db
      .prepare("SELECT relation, strength, derived_from_event_id FROM story_state_relations WHERE id=?")
      .get("rel-1");

    expect(relationRow.relation).toBe("ALLY_OF");
    expect(relationRow.strength).toBeCloseTo(0.8);
    expect(relationRow.derived_from_event_id).toBe("sle-1");

    upsertProjectedRelation(db, {
      id: "rel-1",
      fromIdentityId: "c-su-wan",
      relation: "KNOWS",
      toIdentityId: "c-li-yao",
      visibility: "public",
      strength: 1,
      derivedFromEventId: "sle-2",
      validFromTurn: 2,
    });

    relationRow = db
      .prepare("SELECT relation, strength, derived_from_event_id FROM story_state_relations WHERE id=?")
      .get("rel-1");

    expect(relationRow.relation).toBe("KNOWS");
    expect(relationRow.strength).toBeCloseTo(1);
    expect(relationRow.derived_from_event_id).toBe("sle-2");
  });

  it("persists thread state updates and reads them back", () => {
    const db = createTestDb();

    upsertThreadState(db, {
      threadId: "t-secret-realm",
      stage: "tightening",
      urgency: 0.3,
      pressure: 0.4,
      focusIdentityId: "c-su-wan",
      lastAdvancedTurn: 2,
      lastEventId: "sle-1",
      blockingFactorsJson: "[]",
      pendingPayoffsJson: "[]",
    });

    const stored = getThreadState(db, "t-secret-realm");
    expect(stored).not.toBeNull();
    expect(stored?.stage).toBe("tightening");

    upsertThreadState(db, {
      threadId: "t-secret-realm",
      stage: "showdown",
      urgency: 0.9,
      pressure: 0.95,
      focusIdentityId: "c-li-yao",
      lastAdvancedTurn: 5,
      lastEventId: "sle-2",
      blockingFactorsJson: '["lockdown"]',
      pendingPayoffsJson: '["payoff-ember"]',
    });

    const updated = getThreadState(db, "t-secret-realm");
    expect(updated?.stage).toBe("showdown");
    expect(updated?.focusIdentityId).toBe("c-li-yao");
    expect(updated?.blockingFactorsJson).toBe('["lockdown"]');
  });

  it("migrates schema v2 tables when the runtime DB is initialized", () => {
    const tempPath = join(tmpdir(), `story-schema-v2-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    try {
      const db = getDb(tempPath);
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='story_identities'")
          .get(),
      ).toBeDefined();
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='story_event_ledger'")
          .get(),
      ).toBeDefined();

      const aliasIndexes = db.prepare("PRAGMA index_list('story_identity_aliases')").all() as Array<{
        name: string;
      }>;
      expect(aliasIndexes.some((idx) => idx.name === "ix_story_identity_aliases_identity")).toBe(true);
      expect(
        aliasIndexes.some(
          (idx) => idx.name === "ux_story_identity_aliases_identity_alias_type",
        ),
      ).toBe(true);

      const relationIndexes = db.prepare("PRAGMA index_list('story_state_relations')").all() as Array<{
        name: string;
      }>;
      expect(relationIndexes.some((idx) => idx.name === "ix_story_state_relations_from_to")).toBe(true);
    } finally {
      closeDb();
      if (existsSync(tempPath)) unlinkSync(tempPath);
    }
  });
});
