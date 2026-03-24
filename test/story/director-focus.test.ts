import { describe, expect, it } from "vitest";
import type { StoryNarrativeSignal } from "../../src/store/store.ts";
import { DEFAULT_DIRECTOR_FOCUS_CAP, compactDirectorFocusSignals } from "../../src/story/memory/director-focus.ts";

describe("director focus compaction", () => {
  it("deduplicates semantic duplicates and keeps the freshest representative", () => {
    const compacted = compactDirectorFocusSignals([
      makeSignal({
        id: "s-1",
        kind: "secret",
        subjectId: "c-li-yao",
        relatedId: "t-secret-realm",
        weight: 0.6,
        updatedAt: 100,
      }),
      makeSignal({
        id: "s-2",
        kind: "secret",
        subjectId: "c-li-yao",
        relatedId: "t-secret-realm",
        weight: 0.9,
        updatedAt: 90,
      }),
      makeSignal({
        id: "s-3",
        kind: "secret",
        subjectId: "c-su-wan",
        relatedId: "t-secret-realm",
        weight: 0.8,
        updatedAt: 120,
      }),
    ]);

    expect(compacted).toHaveLength(2);
    expect(compacted[0]?.id).toBe("s-3");
    expect(compacted.map((signal) => signal.id)).toContain("s-1");
    expect(compacted.map((signal) => signal.id)).not.toContain("s-2");
  });

  it("prefers higher weight only after recency is tied", () => {
    const compacted = compactDirectorFocusSignals([
      makeSignal({
        id: "s-1",
        kind: "secret",
        subjectId: "c-li-yao",
        relatedId: "t-secret-realm",
        weight: 0.6,
        updatedAt: 100,
      }),
      makeSignal({
        id: "s-2",
        kind: "secret",
        subjectId: "c-li-yao",
        relatedId: "t-secret-realm",
        weight: 0.9,
        updatedAt: 100,
      }),
    ]);

    expect(compacted).toHaveLength(1);
    expect(compacted[0]?.id).toBe("s-2");
  });

  it("prefers the newest signal when duplicate weights are tied", () => {
    const compacted = compactDirectorFocusSignals([
      makeSignal({
        id: "t-old",
        kind: "tension",
        subjectId: "c-su-wan",
        relatedId: "c-shen-mo",
        weight: 0.8,
        updatedAt: 200,
      }),
      makeSignal({
        id: "t-new",
        kind: "tension",
        subjectId: "c-su-wan",
        relatedId: "c-shen-mo",
        weight: 0.8,
        updatedAt: 300,
      }),
    ]);

    expect(compacted).toHaveLength(1);
    expect(compacted[0]?.id).toBe("t-new");
  });

  it("caps focus items after dedupe to keep snapshots bounded", () => {
    const input = Array.from({ length: DEFAULT_DIRECTOR_FOCUS_CAP + 5 }, (_, index) =>
      makeSignal({
        id: `p-${index}`,
        kind: "payoff-candidate",
        subjectId: `a-${index}`,
        relatedId: `c-${index}`,
        weight: 1 - (index * 0.01),
        updatedAt: 1_000 - index,
      }));

    const compacted = compactDirectorFocusSignals(input);

    expect(compacted).toHaveLength(DEFAULT_DIRECTOR_FOCUS_CAP);
    expect(compacted[0]?.id).toBe("p-0");
    expect(compacted.at(-1)?.id).toBe(`p-${DEFAULT_DIRECTOR_FOCUS_CAP - 1}`);
  });
});

function makeSignal(overrides: Partial<StoryNarrativeSignal> & Pick<StoryNarrativeSignal, "id" | "kind" | "subjectId">):
StoryNarrativeSignal {
  return {
    id: overrides.id,
    kind: overrides.kind,
    subjectId: overrides.subjectId,
    relatedId: overrides.relatedId,
    weight: overrides.weight ?? 0.7,
    payloadJson: overrides.payloadJson ?? "{}",
    status: overrides.status ?? "active",
    createdAt: overrides.createdAt ?? 0,
    updatedAt: overrides.updatedAt ?? 0,
  };
}
