import type { StoryNarrativeSignal } from "../../store/store.ts";

export const DEFAULT_DIRECTOR_FOCUS_CAP = 24;

export function compactDirectorFocusSignals(
  signals: StoryNarrativeSignal[],
  cap = DEFAULT_DIRECTOR_FOCUS_CAP,
): StoryNarrativeSignal[] {
  if (signals.length <= 1) {
    return signals;
  }

  const bestByKey = new Map<string, StoryNarrativeSignal>();
  for (const signal of signals) {
    const dedupeKey = buildSemanticSignalKey(signal);
    const current = bestByKey.get(dedupeKey);
    if (!current || compareSignalPriority(signal, current) < 0) {
      bestByKey.set(dedupeKey, signal);
    }
  }

  return Array.from(bestByKey.values())
    .sort(compareSignalPriority)
    .slice(0, Math.max(0, cap));
}

function buildSemanticSignalKey(signal: StoryNarrativeSignal): string {
  return `${signal.kind}|${signal.subjectId}|${signal.relatedId ?? ""}`;
}

function compareSignalPriority(a: StoryNarrativeSignal, b: StoryNarrativeSignal): number {
  const updatedDelta = (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  if (updatedDelta !== 0) return updatedDelta;

  const createdDelta = (b.createdAt ?? 0) - (a.createdAt ?? 0);
  if (createdDelta !== 0) return createdDelta;

  const weightDelta = (b.weight ?? 0) - (a.weight ?? 0);
  if (weightDelta !== 0) return weightDelta;

  return a.id.localeCompare(b.id);
}
