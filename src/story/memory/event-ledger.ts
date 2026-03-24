/**
 * Durable story ledger helpers for schema v2.
 */
import { type DatabaseSyncInstance } from "@photostructure/sqlite";

export interface StoryLedgerEvent {
  id: string;
  turnNumber: number;
  eventType: string;
  eventPhase: string;
  summary: string;
  visibility: "public" | "private";
  payloadJson: string;
  causedByEventId?: string;
  createdAt?: number;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function normalizePayload(payload: string): string {
  try {
    const parsed = JSON.parse(payload);
    return JSON.stringify(canonicalize(parsed));
  } catch {
    /* fall back to raw string comparison */
    return payload;
  }
}

export function appendStoryLedgerEvent(db: DatabaseSyncInstance, event: StoryLedgerEvent): void {
  const now = event.createdAt ?? Date.now();
  const existing = db.prepare(`
    SELECT turn_number, event_type, event_phase, summary, visibility, payload_json, caused_by_event_id
    FROM story_event_ledger
    WHERE id = ?
  `).get(event.id) as {
    turn_number: number;
    event_type: string;
    event_phase: string;
    summary: string;
    visibility: "public" | "private";
    payload_json: string;
    caused_by_event_id: string | null;
  } | undefined;

  const causedByEventId = event.causedByEventId ?? null;
  const normalizedPayload = normalizePayload(event.payloadJson);

  if (existing) {
    const existingNormalizedPayload = normalizePayload(existing.payload_json);
    if (
      existing.turn_number === event.turnNumber &&
      existing.event_type === event.eventType &&
      existing.event_phase === event.eventPhase &&
      existing.summary === event.summary &&
      existing.visibility === event.visibility &&
      existingNormalizedPayload === normalizedPayload &&
      existing.caused_by_event_id === causedByEventId
    ) {
      return;
    }
    throw new Error(`Conflicting story ledger event ${event.id}`);
  }

  db.prepare(`
    INSERT INTO story_event_ledger (
      id, turn_number, event_type, event_phase, summary,
      visibility, payload_json, caused_by_event_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id,
    event.turnNumber,
    event.eventType,
    event.eventPhase,
    event.summary,
    event.visibility,
    event.payloadJson,
    causedByEventId,
    now,
  );
}
