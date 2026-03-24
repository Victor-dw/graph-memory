import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import type { StoryCharacter, StoryFaction } from "./types.ts";
import { rankActorActions } from "./decision/actor-engine.ts";
import { rankFactionActions } from "./decision/faction-engine.ts";
import { propagateBeliefsFromEvents } from "./beliefs.ts";
import {
  appendStoryLedgerEvent,
  getThreadState,
  insertStoryEvent,
  upsertProjectedRelation,
  insertStoryTurn,
  listStoryBeliefsForActor,
  listStoryEntitiesByKind,
  type StoryBelief,
  type StoryNarrativeSignal,
  type StoryResolvedEvent,
  upsertThreadState,
  upsertStoryNarrativeSignal,
} from "../store/store.ts";
import {
  advanceThreadStateFromSignals,
  deriveThreadStateSignal,
  type ThreadStateSignal,
} from "./memory/thread-state.ts";
import type { StoryModelClient } from "./runtime/model-client.ts";
import {
  applyResolvedEvents,
  deriveNarrativeSignalsFromEvents,
  extractBeliefRelationFromEvent,
  resolveActionConflicts,
  summarizeResolvedEvents,
  type StoryStateChange,
} from "./events.ts";

export interface StoryTurnInput {
  turnNumber: number;
  model: Pick<StoryModelClient, "rerankActorActions" | "rerankFactionActions">;
}

export interface StoryTurnResult {
  turnNumber: number;
  events: StoryResolvedEvent[];
  stateChanges: StoryStateChange[];
}

interface SettledWorldState {
  actors: StoryCharacter[];
  factions: StoryFaction[];
  beliefsByActor: Record<string, StoryBelief[]>;
  beliefsByFaction: Record<string, StoryBelief[]>;
  worldSignals: StoryNarrativeSignal[];
  recentActionCountsByActor: Record<string, Record<string, number>>;
  recentActionCountsByFaction: Record<string, Record<string, number>>;
  recentArtifactConflictCounts: Record<string, number>;
}

export async function runStoryTurn(db: DatabaseSyncInstance, input: StoryTurnInput): Promise<StoryTurnResult> {
  const settlement = settleWorldState(db);
  const actorActions = (await Promise.all(settlement.actors.map((actor) =>
    rankActorActions({
      actor,
      beliefs: settlement.beliefsByActor[actor.id] ?? [],
      worldSignals: settlement.worldSignals,
      recentActionCounts: settlement.recentActionCountsByActor[actor.id] ?? {},
      model: input.model,
    })
  ))).flat();
  const factionActions = (await Promise.all(settlement.factions.map((faction) =>
    rankFactionActions({
      faction,
      beliefs: settlement.beliefsByFaction[faction.id] ?? [],
      worldSignals: settlement.worldSignals,
      recentActionCounts: settlement.recentActionCountsByFaction[faction.id] ?? {},
      model: input.model,
    })
  ))).flat();

  const events = resolveActionConflicts(
    [...actorActions, ...factionActions],
    input.turnNumber,
    settlement.recentArtifactConflictCounts,
  );
  const narrativeSignals = deriveNarrativeSignalsFromEvents(events);
  const updates = persistTurnAtomically(db, input.turnNumber, events, narrativeSignals);

  return { turnNumber: input.turnNumber, events, stateChanges: updates };
}

function persistTurnAtomically(
  db: DatabaseSyncInstance,
  turnNumber: number,
  events: StoryResolvedEvent[],
  narrativeSignals: StoryNarrativeSignal[],
): StoryStateChange[] {
  db.exec("BEGIN");
  try {
    const updates = applyResolvedEvents(db, events);
    const threadStateSignals: ThreadStateSignal[] = [];
    insertStoryTurn(db, {
      turnNumber,
      summary: summarizeResolvedEvents(events),
      payload: { events, stateChanges: updates },
    });
    for (const event of events) {
      insertStoryEvent(db, event);
      const ledgerEventId = `sle-${event.id ?? `${event.turnNumber}-${event.type}`}`;
      appendStoryLedgerEvent(db, {
        id: ledgerEventId,
        turnNumber: event.turnNumber,
        eventType: event.type,
        eventPhase: "resolution",
        summary: event.summary,
        visibility: event.visibility ?? "public",
        payloadJson: JSON.stringify(event.payload),
      });
      const threadStateSignal = deriveThreadStateSignal(event, ledgerEventId);
      if (threadStateSignal) {
        threadStateSignals.push(threadStateSignal);
      }

      const relation = extractBeliefRelationFromEvent(event);
      if (!relation || relation.relation === "EXECUTES") {
        continue;
      }
      upsertProjectedRelation(db, {
        id: `ssr-${relation.fromId}-${relation.relation}-${relation.toId}`,
        fromIdentityId: relation.fromId,
        relation: relation.relation,
        toIdentityId: relation.toId,
        visibility: event.visibility ?? "public",
        derivedFromEventId: ledgerEventId,
        validFromTurn: event.turnNumber,
      });
    }
    for (const signal of narrativeSignals) {
      upsertStoryNarrativeSignal(db, signal);
    }
    const threadUpdates = advanceThreadStateFromSignals(
      threadStateSignals,
      (threadId) => getThreadState(db, threadId),
    );
    for (const threadUpdate of threadUpdates) {
      upsertThreadState(db, threadUpdate);
    }
    propagateBeliefsFromEvents(db, events);
    db.exec("COMMIT");
    return updates;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function settleWorldState(db: DatabaseSyncInstance): SettledWorldState {
  const actors = listStoryEntitiesByKind<StoryCharacter>(db, "character");
  const factions = listStoryEntitiesByKind<StoryFaction>(db, "faction");
  const beliefsByActor = Object.fromEntries(
    actors.map((actor) => [actor.id, listStoryBeliefsForActor(db, actor.id)]),
  );
  const beliefsByFaction = Object.fromEntries(
    factions.map((faction) => [faction.id, listStoryBeliefsForActor(db, faction.id)]),
  );

  const rows = db.prepare(`
    SELECT id, kind, subject_id, related_id, weight, payload_json, status, created_at, updated_at
    FROM story_narrative_signals
    WHERE status = 'active'
    ORDER BY weight DESC, updated_at DESC, id ASC
  `).all() as Array<{
    id: string;
    kind: string;
    subject_id: string;
    related_id: string | null;
    weight: number;
    payload_json: string;
    status: string;
    created_at: number;
    updated_at: number;
  }>;
  const worldSignals = rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    subjectId: row.subject_id,
    relatedId: row.related_id ?? undefined,
    weight: row.weight,
    payloadJson: row.payload_json,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  const recentPatterns = collectRecentPatterns(db);

  return {
    actors,
    factions,
    beliefsByActor,
    beliefsByFaction,
    worldSignals,
    recentActionCountsByActor: recentPatterns.recentActionCountsByActor,
    recentActionCountsByFaction: recentPatterns.recentActionCountsByFaction,
    recentArtifactConflictCounts: recentPatterns.recentArtifactConflictCounts,
  };
}

function collectRecentPatterns(db: DatabaseSyncInstance): {
  recentActionCountsByActor: Record<string, Record<string, number>>;
  recentActionCountsByFaction: Record<string, Record<string, number>>;
  recentArtifactConflictCounts: Record<string, number>;
} {
  const rows = db.prepare(`
    SELECT payload
    FROM story_turns
    ORDER BY turn_number DESC
    LIMIT 6
  `).all() as Array<{ payload: string }>;

  const recentActionCountsByActor: Record<string, Record<string, number>> = {};
  const recentActionCountsByFaction: Record<string, Record<string, number>> = {};
  const recentArtifactConflictCounts: Record<string, number> = {};

  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload) as unknown;
    } catch {
      continue;
    }
    const events = Array.isArray((parsed as { events?: unknown[] })?.events)
      ? (parsed as { events: unknown[] }).events
      : [];

    for (const event of events) {
      if (!event || typeof event !== "object") {
        continue;
      }
      const typedEvent = event as {
        type?: string;
        payload?: {
          subjectId?: string;
          predicate?: string;
          objectId?: string;
          artifactId?: string;
          contenderIds?: string[];
        };
      };
      if (
        (typedEvent.type === "artifact-conflict" || typedEvent.type === "artifact-showdown")
        && typeof typedEvent.payload?.artifactId === "string"
      ) {
        recentArtifactConflictCounts[typedEvent.payload.artifactId] =
          (recentArtifactConflictCounts[typedEvent.payload.artifactId] ?? 0) + 1;
        for (const contenderId of typedEvent.payload.contenderIds ?? []) {
          incrementRecentActionCount(recentActionCountsByActor, contenderId, "seek-artifact");
        }
        continue;
      }

      if (
        typedEvent.payload?.predicate === "EXECUTES"
        && typeof typedEvent.payload.subjectId === "string"
        && typeof typedEvent.payload.objectId === "string"
      ) {
        if (typedEvent.payload.subjectId.startsWith("c-")) {
          incrementRecentActionCount(
            recentActionCountsByActor,
            typedEvent.payload.subjectId,
            typedEvent.payload.objectId,
          );
        } else if (typedEvent.payload.subjectId.startsWith("f-")) {
          incrementRecentActionCount(
            recentActionCountsByFaction,
            typedEvent.payload.subjectId,
            typedEvent.payload.objectId,
          );
        }
      }
    }
  }

  return {
    recentActionCountsByActor,
    recentActionCountsByFaction,
    recentArtifactConflictCounts,
  };
}

function incrementRecentActionCount(
  countsByActor: Record<string, Record<string, number>>,
  actorId: string,
  actionType: string,
): void {
  if (!countsByActor[actorId]) {
    countsByActor[actorId] = {};
  }
  countsByActor[actorId][actionType] = (countsByActor[actorId][actionType] ?? 0) + 1;
}
