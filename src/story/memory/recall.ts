import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import {
  listActiveThreadsForEvents,
  listEventsForPov,
  listNarrativeSignals,
  listRelationshipsForPov,
  type StoryStoredEvent,
  type StoryStoredRelation,
} from "../../store/store.ts";

export function buildRecallPacket(db: DatabaseSyncInstance, params: {
  povId: string;
  eventIds: string[];
}) {
  const legacyEvents = listEventsForPov(db, params.povId, params.eventIds);
  const relatedEvents = listLedgerBackedEventsForPov(db, params.povId, params.eventIds, legacyEvents);
  const projectedRelationships = listProjectedRelationshipsForPov(db, params.povId);
  const filteredProjectedRelationships = projectedRelationships.filter((relation) => relation.relation !== "EXECUTES");
  const relationshipSource = filteredProjectedRelationships.length > 0
    ? filteredProjectedRelationships
    : listRelationshipsForPov(db, params.povId).filter((relation) => relation.relation !== "EXECUTES");
  const v2Threads = listThreadsFromThreadState(db, relatedEvents);
  return {
    relatedEvents,
    relationships: relationshipSource,
    threads: v2Threads.length > 0 ? v2Threads : listActiveThreadsForEvents(db, params.povId, params.eventIds),
    unresolvedSecrets: listNarrativeSignals(db, "secret", params.povId),
    activeTensions: listNarrativeSignals(db, "tension", params.povId),
    payoffCandidates: listNarrativeSignals(db, "payoff-candidate", params.povId),
  };
}

function listLedgerBackedEventsForPov(
  db: DatabaseSyncInstance,
  povId: string,
  eventIds: string[],
  legacyEvents: StoryStoredEvent[],
): StoryStoredEvent[] {
  const visibleLegacyById = new Map(legacyEvents.map((event) => [event.id, event]));
  const visibleEventIds = legacyEvents.map((event) => event.id);
  const fallbackEventIds = visibleEventIds.length > 0 ? visibleEventIds : eventIds;
  if (fallbackEventIds.length === 0) return [];
  const placeholders = fallbackEventIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT id, turn_number, event_type, summary, visibility, payload_json, created_at
    FROM story_event_ledger
    WHERE id IN (${placeholders})
    ORDER BY created_at ASC, id ASC
  `).all(...fallbackEventIds.map((eventId) => `sle-${eventId}`)) as Array<{
    id: string;
    turn_number: number;
    event_type: string;
    summary: string;
    visibility: "public" | "private";
    payload_json: string;
    created_at: number;
  }>;

  const ledgerByEventId = new Map<string, StoryStoredEvent>();
  for (const row of rows) {
    const eventId = row.id.startsWith("sle-") ? row.id.slice(4) : row.id;
    const payload = parseJson(row.payload_json);
    if (payload === null) continue;
    const legacy = visibleLegacyById.get(eventId);
    if (!legacy && row.visibility === "private") {
      continue;
    }
    if (!legacy && row.visibility !== "public") {
      continue;
    }
    ledgerByEventId.set(eventId, {
      id: eventId,
      turnNumber: row.turn_number,
      type: row.event_type,
      summary: row.summary,
      payload,
      visibility: row.visibility,
      observers: legacy?.observers ?? inferObserversForLedgerPayload(payload, povId, row.visibility),
      createdAt: row.created_at,
    });
  }

  if (legacyEvents.length > 0) {
    return legacyEvents.map((event) => ledgerByEventId.get(event.id) ?? event);
  }
  return Array.from(ledgerByEventId.values());
}

function inferObserversForLedgerPayload(
  payload: unknown,
  povId: string,
  visibility: "public" | "private",
): string[] {
  if (visibility === "public") return [];
  const subjectId = (payload as { subjectId?: unknown } | null)?.subjectId;
  if (typeof subjectId === "string" && subjectId === povId) {
    return [povId];
  }
  return [];
}

function listProjectedRelationshipsForPov(db: DatabaseSyncInstance, povId: string): StoryStoredRelation[] {
  const rows = db.prepare(`
    SELECT id, from_identity_id, relation, to_identity_id, visibility, strength, derived_from_event_id
    FROM story_state_relations
    WHERE (
      visibility != 'private' AND (from_identity_id = ? OR to_identity_id = ?)
    ) OR (
      visibility = 'private' AND from_identity_id = ?
    )
    ORDER BY updated_at DESC, id ASC
  `).all(povId, povId, povId) as Array<{
    id: string;
    from_identity_id: string;
    relation: string;
    to_identity_id: string;
    visibility: string;
    strength: number;
    derived_from_event_id: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    fromId: row.from_identity_id,
    relation: row.relation,
    toId: row.to_identity_id,
    visibility: row.visibility,
    intensity: row.strength,
    sourceEventId: row.derived_from_event_id ?? undefined,
  }));
}

function listThreadsFromThreadState(
  db: DatabaseSyncInstance,
  events: StoryStoredEvent[],
): Array<Record<string, unknown>> {
  const threadIds = collectThreadIds(events);
  if (threadIds.length === 0) return [];
  const placeholders = threadIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT
      e.id,
      e.payload,
      ts.stage,
      ts.urgency,
      ts.pressure,
      ts.focus_identity_id,
      ts.last_advanced_turn,
      ts.last_event_id,
      ts.blocking_factors_json,
      ts.pending_payoffs_json
    FROM story_entities e
    LEFT JOIN story_thread_state ts ON ts.thread_id = e.id
    WHERE e.kind = 'thread' AND e.status = 'active' AND e.id IN (${placeholders})
    ORDER BY e.created_at ASC, e.id ASC
  `).all(...threadIds) as Array<{
    id: string;
    payload: string;
    stage: string | null;
    urgency: number | null;
    pressure: number | null;
    focus_identity_id: string | null;
    last_advanced_turn: number | null;
    last_event_id: string | null;
    blocking_factors_json: string | null;
    pending_payoffs_json: string | null;
  }>;
  return rows.flatMap((row) => {
    const payload = parseJson(row.payload);
    if (!payload || typeof payload !== "object") {
      console.warn("[story-recall] skipped malformed thread payload row");
      return [];
    }
    const threadRecord: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
    if (row.stage) threadRecord.stage = row.stage;
    if (typeof row.urgency === "number") threadRecord.urgency = row.urgency;
    if (typeof row.pressure === "number") threadRecord.pressure = row.pressure;
    if (row.focus_identity_id) threadRecord.focusIdentityId = row.focus_identity_id;
    if (typeof row.last_advanced_turn === "number") threadRecord.lastAdvancedTurn = row.last_advanced_turn;
    if (row.last_event_id) threadRecord.lastEventId = row.last_event_id;
    if (row.blocking_factors_json) threadRecord.blockingFactorsJson = row.blocking_factors_json;
    if (row.pending_payoffs_json) threadRecord.pendingPayoffsJson = row.pending_payoffs_json;
    return [threadRecord];
  });
}

function collectThreadIds(events: StoryStoredEvent[]): string[] {
  const threadIds = new Set<string>();
  for (const event of events) {
    const payload = event.payload as { threadId?: unknown; threadIds?: unknown } | null;
    if (typeof payload?.threadId === "string" && payload.threadId.length > 0) {
      threadIds.add(payload.threadId);
    }
    if (Array.isArray(payload?.threadIds)) {
      for (const threadId of payload.threadIds) {
        if (typeof threadId === "string" && threadId.length > 0) {
          threadIds.add(threadId);
        }
      }
    }
  }
  return Array.from(threadIds);
}

function parseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
