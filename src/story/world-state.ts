import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { createSeedWorld } from "./bootstrap.ts";
import { saveDirectorState, type NarrativeDirectorState } from "./narrative/state.ts";
import type { SeedWorld, StoryCharacter, StoryThread } from "./types.ts";
import { propagateBeliefsFromEvents } from "./beliefs.ts";
import type { StoryWorldSnapshot } from "./memory/consistency.ts";
import {
  insertStoryIdentity,
  insertStoryEntities,
  insertStoryEvent,
  type StoryBelief,
  insertStoryRelation,
  insertStoryTurn,
  listStoryEntitiesByKind,
  type StoryNarrativeSignal,
  type StoryResolvedEvent,
  type StoryThreadStateRecord,
  type StoryTurnRecord,
  upsertProjectedRelation,
  upsertStoryNarrativeSignal,
  upsertThreadState,
} from "../store/store.ts";

export interface StoryWorldState {
  listCharacters(): StoryCharacter[];
  listThreads(): StoryThread[];
  saveSeed(seed: SeedWorld): void;
  recordTurn(turn: StoryTurnRecord): void;
  recordEvents(events: StoryResolvedEvent[]): void;
  recordChapter(chapter: {
    turnNumber: number;
    povId: string;
    summary: string;
    prose: string;
    claimsJson: string;
  }): void;
  saveDirectorStateSnapshot(key: string, valueJson: string): void;
  upsertNarrativeSignal(signal: StoryNarrativeSignal): void;
  upsertNarrativeSignals(signals: StoryNarrativeSignal[]): void;
}

export function createStoryWorldState(db: DatabaseSyncInstance): StoryWorldState {
  return {
    listCharacters() {
      return listStoryEntitiesByKind<StoryCharacter>(db, "character");
    },
    listThreads() {
      return listStoryEntitiesByKind<StoryThread>(db, "thread");
    },
    saveSeed(seed) {
      const presentIds = new Set<string>([
        ...seed.characters.map((entity) => entity.id),
        ...seed.factions.map((entity) => entity.id),
        ...seed.locations.map((entity) => entity.id),
        ...seed.artifacts.map((entity) => entity.id),
        ...seed.threads.map((entity) => entity.id),
        ...seed.rules.map((entity) => entity.id),
      ]);
      const canonicalRelations = [
        {
          id: "sr-li-yao-knows-su-wan",
          fromId: "c-li-yao",
          relation: "KNOWS",
          toId: "c-su-wan",
          visibility: "public",
        },
        {
          id: "sr-li-yao-feels-su-wan",
          fromId: "c-li-yao",
          relation: "FEELS",
          toId: "c-su-wan",
          visibility: "private",
          intensity: 0.6,
        },
        {
          id: "sr-ember-seal-owns-shen-mo",
          fromId: "a-ember-seal",
          relation: "OWNS",
          toId: "c-shen-mo",
          visibility: "public",
        },
      ].filter((relation) => presentIds.has(relation.fromId) && presentIds.has(relation.toId));
      const canonicalSignals = [
        {
          id: "ns-secret-bloodline",
          kind: "secret",
          subjectId: "c-li-yao",
          relatedId: "t-secret-realm",
          weight: 0.8,
          payloadJson: JSON.stringify({ secret: "ancient-bloodline" }),
          status: "active",
        },
        {
          id: "ns-realm-tension",
          kind: "tension",
          subjectId: "f-cloud-sword",
          relatedId: "t-secret-realm",
          weight: 0.7,
          payloadJson: JSON.stringify({ cause: "inheritance-dispute" }),
          status: "active",
        },
      ].filter((signal) => {
        const hasSubject = presentIds.has(signal.subjectId);
        const hasRelated = signal.relatedId ? presentIds.has(signal.relatedId) : true;
        return hasSubject && hasRelated;
      });

      db.exec("BEGIN");
      try {
        insertStoryEntities(db, seed.characters, "character");
        insertStoryEntities(db, seed.factions, "faction");
        insertStoryEntities(db, seed.locations, "location");
        insertStoryEntities(db, seed.artifacts, "artifact");
        insertStoryEntities(db, seed.threads, "thread");
        insertStoryEntities(db, seed.rules, "rule");

        for (const relation of canonicalRelations) {
          insertStoryRelation(db, relation);
        }
        for (const signal of canonicalSignals) {
          upsertStoryNarrativeSignal(db, signal);
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    recordTurn(turn) {
      insertStoryTurn(db, turn);
    },
    recordEvents(events) {
      db.exec("BEGIN");
      try {
        for (const event of events) {
          insertStoryEvent(db, event);
        }
        propagateBeliefsFromEvents(db, events);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    recordChapter(chapter) {
      db.prepare(`
        INSERT INTO story_chapters (id, turn_number, pov_id, summary, prose, claims_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        `sch-${chapter.turnNumber}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        chapter.turnNumber,
        chapter.povId,
        chapter.summary,
        chapter.prose,
        chapter.claimsJson,
        Date.now(),
      );
    },
    saveDirectorStateSnapshot(key, valueJson) {
      db.prepare(`
        INSERT INTO story_director_state (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `).run(key, valueJson, Date.now());
    },
    upsertNarrativeSignal(signal) {
      upsertStoryNarrativeSignal(db, signal);
    },
    upsertNarrativeSignals(signals) {
      db.exec("BEGIN");
      try {
        for (const signal of signals) {
          upsertStoryNarrativeSignal(db, signal);
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

export function initializeStoryWorld(db: DatabaseSyncInstance): StoryWorldState {
  const world = createStoryWorldState(db);
  if (world.listCharacters().length === 0) {
    world.saveSeed(createSeedWorld());
  } else if (countActiveNarrativeSignals(db) === 0) {
    for (const signal of listCanonicalNarrativeSignals(listPresentEntityIds(db))) {
      world.upsertNarrativeSignal(signal);
    }
  }
  return world;
}

export interface StoryRestoreSnapshot {
  world: StoryWorldSnapshot;
  beliefs: StoryBelief[];
  director: NarrativeDirectorState;
  resumeTurnNumber?: number;
}

export function restoreStorySnapshot(
  db: DatabaseSyncInstance,
  snapshot: StoryRestoreSnapshot,
): void {
  db.exec("BEGIN");
  try {
    clearPersistedStorySnapshot(db);

    const entitiesByKind = new Map<string, Array<{ id: string; name: string }>>();
    for (const entity of snapshot.world.entities) {
      if (!entitiesByKind.has(entity.kind)) {
        entitiesByKind.set(entity.kind, []);
      }
      entitiesByKind.get(entity.kind)?.push(entity.payload as { id: string; name: string });
    }

    for (const [kind, entities] of entitiesByKind.entries()) {
      insertStoryEntities(db, entities, kind as "character" | "faction" | "location" | "artifact" | "thread" | "rule");
    }

    for (const identity of snapshot.world.identities ?? []) {
      insertStoryIdentity(db, identity);
    }

    for (const relation of snapshot.world.relations) {
      insertStoryRelation(db, {
        id: relation.id,
        fromId: relation.fromId,
        relation: relation.relation,
        toId: relation.toId,
        visibility: relation.visibility,
        intensity: relation.intensity,
        sourceEventId: relation.sourceEventId,
        createdAt: relation.createdAt,
        updatedAt: relation.updatedAt,
      });
    }

    for (const relation of toProjectedSnapshotRelations(snapshot.world)) {
      upsertProjectedRelation(db, {
        id: relation.id,
        fromIdentityId: relation.fromIdentityId,
        relation: relation.relation,
        toIdentityId: relation.toIdentityId,
        visibility: relation.visibility === "private" ? "private" : "public",
        strength: relation.strength,
        derivedFromEventId: relation.derivedFromEventId,
        validFromTurn: relation.validFromTurn,
        updatedAt: relation.updatedAt,
      });
    }

    for (const threadState of toSnapshotThreadState(snapshot.world)) {
      upsertThreadState(db, threadState);
    }

    for (const signal of snapshot.world.narrativeSignals) {
      upsertStoryNarrativeSignal(db, {
        id: signal.id,
        kind: signal.kind,
        subjectId: signal.subjectId,
        relatedId: signal.relatedId,
        weight: signal.weight,
        payloadJson: signal.payloadJson,
        status: signal.status,
        createdAt: signal.createdAt,
        updatedAt: signal.updatedAt,
      });
    }

    for (const belief of snapshot.beliefs) {
      db.prepare(`
        INSERT INTO story_beliefs (
          id, actor_id, subject_id, predicate, object_id, confidence, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(actor_id, subject_id, predicate) DO UPDATE SET
          object_id = excluded.object_id,
          confidence = excluded.confidence,
          updated_at = excluded.updated_at
      `).run(
        `sb-restore-${belief.actorId}-${belief.subjectId}-${belief.predicate}`,
        belief.actorId,
        belief.subjectId,
        belief.predicate,
        belief.objectId,
        belief.confidence,
        Date.now(),
        Date.now(),
      );
    }

    if (snapshot.resumeTurnNumber && snapshot.resumeTurnNumber > 0) {
      insertStoryTurn(db, {
        turnNumber: snapshot.resumeTurnNumber,
        summary: `Restored continuation checkpoint at turn ${snapshot.resumeTurnNumber}`,
        payload: { restored: true, resumeTurnNumber: snapshot.resumeTurnNumber },
      });
    }

    saveDirectorState(db, snapshot.director);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function listCanonicalNarrativeSignals(presentIds: Set<string>) {
  return [
    {
      id: "ns-secret-bloodline",
      kind: "secret",
      subjectId: "c-li-yao",
      relatedId: "t-secret-realm",
      weight: 0.8,
      payloadJson: JSON.stringify({ secret: "ancient-bloodline" }),
      status: "active",
    },
    {
      id: "ns-realm-tension",
      kind: "tension",
      subjectId: "f-cloud-sword",
      relatedId: "t-secret-realm",
      weight: 0.7,
      payloadJson: JSON.stringify({ cause: "inheritance-dispute" }),
      status: "active",
    },
  ].filter((signal) => {
    const hasSubject = presentIds.has(signal.subjectId);
    const hasRelated = signal.relatedId ? presentIds.has(signal.relatedId) : true;
    return hasSubject && hasRelated;
  });
}

function listPresentEntityIds(db: DatabaseSyncInstance): Set<string> {
  const kinds = ["character", "faction", "location", "artifact", "thread", "rule"] as const;
  return new Set<string>(
    kinds.flatMap((kind) =>
      listStoryEntitiesByKind<{ id: string }>(db, kind).map((entity) => entity.id)
    ),
  );
}

function countActiveNarrativeSignals(db: DatabaseSyncInstance): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM story_narrative_signals
    WHERE status = 'active'
  `).get() as { count: number } | undefined;
  return row?.count ?? 0;
}

function clearPersistedStorySnapshot(db: DatabaseSyncInstance): void {
  const tables = [
    "story_turns",
    "story_events",
    "story_event_ledger",
    "story_beliefs",
    "story_chapters",
    "story_director_state",
    "story_narrative_signals",
    "story_state_relations",
    "story_thread_state",
    "story_relations",
    "story_identity_aliases",
    "story_identities",
    "story_entities",
  ] as const;

  for (const table of tables) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
}

function toProjectedSnapshotRelations(world: StoryRestoreSnapshot["world"]) {
  if ((world.projectedRelations?.length ?? 0) > 0) {
    return world.projectedRelations ?? [];
  }

  return world.relations.map((relation) => ({
    id: relation.id,
    fromIdentityId: relation.fromId,
    relation: relation.relation,
    toIdentityId: relation.toId,
    visibility: relation.visibility,
    strength: relation.intensity,
    derivedFromEventId: relation.sourceEventId,
    validFromTurn: relation.validFromTurn,
    updatedAt: relation.updatedAt,
  }));
}

function toSnapshotThreadState(world: StoryRestoreSnapshot["world"]): StoryThreadStateRecord[] {
  if ((world.threadState?.length ?? 0) > 0) {
    return world.threadState ?? [];
  }

  return world.activeThreads.flatMap((thread) => {
    const snapshotThread = thread as StoryThread & Partial<StoryThreadStateRecord>;
    const hasThreadState = typeof snapshotThread.stage === "string"
      || typeof snapshotThread.urgency === "number"
      || typeof snapshotThread.pressure === "number"
      || typeof snapshotThread.focusIdentityId === "string"
      || typeof snapshotThread.lastAdvancedTurn === "number"
      || typeof snapshotThread.lastEventId === "string"
      || typeof snapshotThread.blockingFactorsJson === "string"
      || typeof snapshotThread.pendingPayoffsJson === "string";
    if (!hasThreadState) {
      return [];
    }

    return [{
      threadId: snapshotThread.id,
      stage: snapshotThread.stage ?? "opening",
      urgency: snapshotThread.urgency ?? 0,
      pressure: snapshotThread.pressure ?? 0,
      focusIdentityId: snapshotThread.focusIdentityId ?? null,
      lastAdvancedTurn: snapshotThread.lastAdvancedTurn ?? null,
      lastEventId: snapshotThread.lastEventId ?? null,
      blockingFactorsJson: snapshotThread.blockingFactorsJson ?? "[]",
      pendingPayoffsJson: snapshotThread.pendingPayoffsJson ?? "[]",
      updatedAt: Date.now(),
    }];
  });
}
