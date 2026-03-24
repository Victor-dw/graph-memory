import {
  STORY_THREAD_STAGES,
  type StoryResolvedEvent,
  type StoryThreadStage,
  type StoryThreadStateRecord,
} from "../../store/store.ts";

const STAGE_RANK: Record<StoryThreadStage, number> = {
  opening: 0,
  tightening: 1,
  showdown: 2,
  aftermath: 3,
};

export interface ThreadStateSignal {
  threadId: string;
  eventType: "artifact-conflict" | "artifact-showdown";
  turnNumber: number;
  ledgerEventId: string;
  focusIdentityId?: string;
}

export function deriveThreadStateSignal(
  event: StoryResolvedEvent,
  ledgerEventId: string,
): ThreadStateSignal | null {
  if (event.type !== "artifact-conflict" && event.type !== "artifact-showdown") {
    return null;
  }
  const payload = event.payload as {
    threadId?: string;
    threadIds?: string[];
    contenderIds?: string[];
    subjectId?: string;
  } | null;
  const threadId = selectThreadId(payload);
  if (!threadId) return null;

  return {
    threadId,
    eventType: event.type,
    turnNumber: event.turnNumber,
    ledgerEventId,
    focusIdentityId: selectFocusIdentity(payload),
  };
}

export function advanceThreadStateFromSignals(
  signals: ThreadStateSignal[],
  readCurrentState: (threadId: string) => StoryThreadStateRecord | null,
): StoryThreadStateRecord[] {
  const initialByThread = new Map<string, StoryThreadStateRecord | null>();
  const latestByThread = new Map<string, StoryThreadStateRecord>();

  for (const signal of signals) {
    const current = latestByThread.get(signal.threadId)
      ?? getOrReadInitialState(signal.threadId, initialByThread, readCurrentState);
    const next = advanceThreadState(current, signal);
    latestByThread.set(signal.threadId, next);
  }

  const updates: StoryThreadStateRecord[] = [];
  for (const [threadId, next] of latestByThread) {
    const initial = initialByThread.get(threadId) ?? null;
    if (!threadStateEquals(initial, next)) {
      updates.push(next);
    }
  }
  return updates;
}

function getOrReadInitialState(
  threadId: string,
  cache: Map<string, StoryThreadStateRecord | null>,
  readCurrentState: (threadId: string) => StoryThreadStateRecord | null,
): StoryThreadStateRecord | null {
  if (cache.has(threadId)) {
    return cache.get(threadId) ?? null;
  }
  const current = readCurrentState(threadId);
  cache.set(threadId, current);
  return current;
}

function advanceThreadState(
  current: StoryThreadStateRecord | null,
  signal: ThreadStateSignal,
): StoryThreadStateRecord {
  const baseline = current ?? {
    threadId: signal.threadId,
    stage: "opening",
    urgency: 0.25,
    pressure: 0.3,
    focusIdentityId: null,
    lastAdvancedTurn: null,
    lastEventId: null,
    blockingFactorsJson: "[]",
    pendingPayoffsJson: "[]",
  };
  const pendingPayoffs = parseJsonArray(baseline.pendingPayoffsJson);

  const targetStage: StoryThreadStage = signal.eventType === "artifact-showdown" ? "showdown" : "tightening";
  const nextStage = maxStage(asKnownStage(baseline.stage), targetStage);
  const urgencyStep = signal.eventType === "artifact-showdown" ? 0.3 : 0.2;
  const pressureStep = signal.eventType === "artifact-showdown" ? 0.35 : 0.25;
  const urgencyFloor = signal.eventType === "artifact-showdown" ? 0.9 : 0.45;
  const pressureFloor = signal.eventType === "artifact-showdown" ? 0.95 : 0.55;
  const urgency = signal.eventType === "artifact-showdown"
    ? Math.max(baseline.urgency, urgencyFloor)
    : Math.max(baseline.urgency + urgencyStep, urgencyFloor);
  const pressure = signal.eventType === "artifact-showdown"
    ? Math.max(baseline.pressure, pressureFloor)
    : Math.max(baseline.pressure + pressureStep, pressureFloor);

  if (signal.eventType === "artifact-showdown") {
    const payoffId = `stabilize-${signal.threadId}`;
    if (!pendingPayoffs.includes(payoffId)) {
      pendingPayoffs.push(payoffId);
    }
  }

  return {
    threadId: signal.threadId,
    stage: nextStage,
    urgency: clamp01(urgency),
    pressure: clamp01(pressure),
    focusIdentityId: signal.focusIdentityId ?? baseline.focusIdentityId ?? null,
    lastAdvancedTurn: signal.turnNumber,
    lastEventId: signal.ledgerEventId,
    blockingFactorsJson: signal.eventType === "artifact-showdown" ? "[]" : (baseline.blockingFactorsJson ?? "[]"),
    pendingPayoffsJson: JSON.stringify(pendingPayoffs),
  };
}

function selectThreadId(payload: { threadId?: string; threadIds?: string[] } | null): string | null {
  if (typeof payload?.threadId === "string" && payload.threadId.length > 0) return payload.threadId;
  if (Array.isArray(payload?.threadIds)) {
    const firstThreadId = payload.threadIds.find((candidate) => typeof candidate === "string" && candidate.length > 0);
    if (firstThreadId) return firstThreadId;
  }
  return null;
}

function selectFocusIdentity(payload: { contenderIds?: string[]; subjectId?: string } | null): string | undefined {
  if (Array.isArray(payload?.contenderIds)) {
    const firstContender = payload.contenderIds.find((contenderId) => typeof contenderId === "string" && contenderId.length > 0);
    if (firstContender) return firstContender;
  }
  if (typeof payload?.subjectId === "string" && payload.subjectId.length > 0) {
    return payload.subjectId;
  }
  return undefined;
}

function parseJsonArray(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

function asKnownStage(stage: string): StoryThreadStage {
  return STORY_THREAD_STAGES.includes(stage as StoryThreadStage) ? (stage as StoryThreadStage) : "opening";
}

function maxStage(left: StoryThreadStage, right: StoryThreadStage): StoryThreadStage {
  return STAGE_RANK[left] >= STAGE_RANK[right] ? left : right;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function threadStateEquals(
  left: StoryThreadStateRecord | null,
  right: StoryThreadStateRecord,
): boolean {
  if (!left) return false;
  return left.threadId === right.threadId
    && left.stage === right.stage
    && left.urgency === right.urgency
    && left.pressure === right.pressure
    && (left.focusIdentityId ?? null) === (right.focusIdentityId ?? null)
    && (left.lastAdvancedTurn ?? null) === (right.lastAdvancedTurn ?? null)
    && (left.lastEventId ?? null) === (right.lastEventId ?? null)
    && (left.blockingFactorsJson ?? "[]") === (right.blockingFactorsJson ?? "[]")
    && (left.pendingPayoffsJson ?? "[]") === (right.pendingPayoffsJson ?? "[]");
}
