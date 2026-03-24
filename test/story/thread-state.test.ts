import { describe, expect, it } from "vitest";
import type { StoryThreadStateRecord } from "../../src/store/store.ts";
import {
  advanceThreadStateFromSignals,
  type ThreadStateSignal,
} from "../../src/story/memory/thread-state.ts";

describe("thread state advancement", () => {
  it("ignores events that are not linked to a thread", () => {
    const updates = advanceThreadStateFromSignals(
      [],
      () => null,
    );

    expect(updates).toEqual([]);
  });

  it("starts an unresolved thread in tightening on artifact conflict", () => {
    const updates = advanceThreadStateFromSignals(
      [
        {
          threadId: "t-secret-realm",
          eventType: "artifact-conflict",
          turnNumber: 2,
          ledgerEventId: "sle-sev-2-1",
          focusIdentityId: "c-li-yao",
        },
      ] satisfies ThreadStateSignal[],
      () => null,
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      threadId: "t-secret-realm",
      stage: "tightening",
      focusIdentityId: "c-li-yao",
      lastAdvancedTurn: 2,
      lastEventId: "sle-sev-2-1",
    });
    expect(updates[0]?.urgency).toBeCloseTo(0.45);
    expect(updates[0]?.pressure).toBeCloseTo(0.55);
  });

  it("escalates a tightening thread into showdown when showdown events repeat", () => {
    const currentState: StoryThreadStateRecord = {
      threadId: "t-secret-realm",
      stage: "tightening",
      urgency: 0.6,
      pressure: 0.7,
      focusIdentityId: "c-su-wan",
      lastAdvancedTurn: 9,
      lastEventId: "sev-9-1",
      blockingFactorsJson: '["elder-surveillance"]',
      pendingPayoffsJson: '["reveal-heir"]',
    };
    const updates = advanceThreadStateFromSignals(
      [
        {
          threadId: "t-secret-realm",
          eventType: "artifact-showdown",
          turnNumber: 10,
          ledgerEventId: "sle-sev-10-1",
          focusIdentityId: "c-su-wan",
        },
      ] satisfies ThreadStateSignal[],
      (threadId) => (threadId === "t-secret-realm" ? currentState : null),
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      threadId: "t-secret-realm",
      stage: "showdown",
      focusIdentityId: "c-su-wan",
      lastAdvancedTurn: 10,
      lastEventId: "sle-sev-10-1",
      blockingFactorsJson: "[]",
    });
    expect(updates[0]?.urgency).toBeCloseTo(0.9);
    expect(updates[0]?.pressure).toBeCloseTo(0.95);
    expect(updates[0]?.pendingPayoffsJson).toContain("stabilize-t-secret-realm");
  });

  it("processes multiple updates in event order for the same thread", () => {
    const stateByThread = new Map<string, StoryThreadStateRecord>([
      [
        "t-secret-realm",
        {
          threadId: "t-secret-realm",
          stage: "opening",
          urgency: 0.2,
          pressure: 0.25,
          blockingFactorsJson: "[]",
          pendingPayoffsJson: "[]",
        },
      ],
    ]);

    const updates = advanceThreadStateFromSignals(
      [
        {
          threadId: "t-secret-realm",
          eventType: "artifact-conflict",
          turnNumber: 11,
          ledgerEventId: "sle-sev-11-1",
          focusIdentityId: "c-li-yao",
        },
        {
          threadId: "t-secret-realm",
          eventType: "artifact-showdown",
          turnNumber: 11,
          ledgerEventId: "sle-sev-11-2",
          focusIdentityId: "c-li-yao",
        },
      ] satisfies ThreadStateSignal[],
      (threadId) => stateByThread.get(threadId) ?? null,
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      threadId: "t-secret-realm",
      stage: "showdown",
      lastEventId: "sle-sev-11-2",
      lastAdvancedTurn: 11,
    });
    expect(updates[0]?.focusIdentityId).toBe("c-li-yao");
  });
});
