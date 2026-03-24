import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import {
  insertStoryRelation,
  listObservableActors,
  listObservableFactions,
  listStoryBeliefsForActor,
  type StoryBelief,
  type StoryResolvedEvent,
  upsertStoryBelief,
} from "../store/store.ts";

interface BeliefEventPayload {
  subjectId?: string;
  predicate?: string;
  objectId?: string;
  contenderIds?: string[];
  confidence?: number;
}

export interface StoryBeliefRepository {
  upsertBelief(belief: StoryBelief): StoryBelief;
  recordRelation(fromId: string, relation: string, toId: string): { fromId: string; relation: string; toId: string };
}

function inferActorKind(actorId: string): "character" | "faction" {
  return actorId.startsWith("f-") ? "faction" : "character";
}

export function createStoryBeliefRepository(db: DatabaseSyncInstance): StoryBeliefRepository {
  return {
    upsertBelief(belief) {
      return upsertStoryBelief(db, belief);
    },
    recordRelation(fromId, relation, toId) {
      insertStoryRelation(db, { fromId, relation, toId, visibility: "public" });
      return { fromId, relation, toId };
    },
  };
}

export function listBeliefsForActor(db: DatabaseSyncInstance, actorId: string): StoryBelief[] {
  return listStoryBeliefsForActor(db, actorId);
}

export function buildStoryBeliefSnapshot(db: DatabaseSyncInstance): StoryBelief[] {
  const actorRows = db.prepare(`
    SELECT DISTINCT actor_id
    FROM story_beliefs
    ORDER BY actor_id ASC
  `).all() as Array<{ actor_id: string }>;

  return actorRows.flatMap((row) => listStoryBeliefsForActor(db, row.actor_id));
}

export function upsertBeliefFromEvent(db: DatabaseSyncInstance, actorId: string, event: StoryResolvedEvent): void {
  const payload = event.payload as BeliefEventPayload | null;
  if (!payload?.subjectId || !payload?.predicate || !payload?.objectId) return;

  upsertStoryBelief(db, {
    actorId,
    actorKind: inferActorKind(actorId),
    subjectId: payload.subjectId,
    predicate: payload.predicate,
    objectId: payload.objectId,
    confidence: payload.confidence ?? 0.75,
  });
}

function collectBeliefRecipients(event: StoryResolvedEvent, knownHolders: Set<string>): string[] {
  const recipients = new Set<string>();
  const payload = event.payload as BeliefEventPayload | null;

  for (const observerId of event.observers ?? []) {
    if (knownHolders.has(observerId)) {
      recipients.add(observerId);
    }
  }

  if (typeof payload?.subjectId === "string" && knownHolders.has(payload.subjectId)) {
    recipients.add(payload.subjectId);
  }
  if (typeof payload?.objectId === "string" && knownHolders.has(payload.objectId)) {
    recipients.add(payload.objectId);
  }
  for (const contenderId of payload?.contenderIds ?? []) {
    if (knownHolders.has(contenderId)) {
      recipients.add(contenderId);
    }
  }

  return [...recipients];
}

export function propagateBeliefsFromEvents(db: DatabaseSyncInstance, events: StoryResolvedEvent[]): void {
  const knownHolders = new Set<string>([
    ...listObservableActors(db),
    ...listObservableFactions(db),
  ]);

  for (const event of events) {
    const recipients = collectBeliefRecipients(event, knownHolders);
    for (const actorId of recipients) {
      upsertBeliefFromEvent(db, actorId, event);
    }
  }
}
