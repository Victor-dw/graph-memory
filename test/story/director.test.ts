import { describe, expect, it } from "vitest";
import type { StoryResolvedEvent, StoryNarrativeSignal } from "../../src/store/store.ts";
import { selectChapterFocus, type EnsembleHeatEntry } from "../../src/story/narrative/director.ts";
import type { ChapterSelection as RuntimeChapterSelection, NarrativeDirectorInput as RuntimeNarrativeDirectorInput } from "../../src/story/runtime/model-client.ts";
import type { StoryThread } from "../../src/story/types.ts";
import { loadDirectorState, saveDirectorState, type NarrativeDirectorState, updateDirectorStateFromTurn } from "../../src/story/narrative/state.ts";
import { createTestDb } from "../helpers.ts";

describe("narrative director", () => {
  it("selects a single primary pov and chapter-worthy event bundle", async () => {
    const choice = await selectChapterFocus({
      events: fixtureEvents,
      activeTensions: fixtureTensions,
      activeThreads: fixtureThreads,
      ensembleState: fixtureEnsemble,
      recentPovIds: ["c-li-yao", "c-li-yao"],
      model: fakeDirectorModel(),
    });

    expect(choice.primaryPovId).toBeDefined();
    expect(choice.eventIds.length).toBeGreaterThan(0);
  });

  it("avoids repeating the same pov when recent pov history is saturated", async () => {
    const choice = await selectChapterFocus({
      events: fixtureEvents,
      activeThreads: fixtureThreads,
      activeTensions: fixtureTensions,
      ensembleState: fixtureEnsemble,
      recentPovIds: ["c-li-yao", "c-li-yao", "c-li-yao"],
      model: fakeDirectorModel(),
    });
    expect(choice.primaryPovId).not.toBe("c-li-yao");
  });

  it("does not pick high-heat offstage povs with zero event relevance", async () => {
    const choice = await selectChapterFocus({
      events: fixtureEvents,
      activeThreads: fixtureThreads,
      activeTensions: fixtureTensions,
      ensembleState: [
        ...fixtureEnsemble,
        { entityId: "c-offstage", heat: 100 },
      ],
      recentPovIds: [],
      model: fakeDirectorModel(),
    });

    expect(choice.primaryPovId).not.toBe("c-offstage");
  });

  it("treats artifact showdown contenders as onstage participants for chapter focus", async () => {
    const choice = await selectChapterFocus({
      events: [
        {
          id: "sev-8-1",
          turnNumber: 8,
          type: "artifact-showdown",
          summary: "The Ember Seal showdown forces all hidden players into the open.",
          payload: {
            artifactId: "a-ember-seal",
            conflictId: "conflict:a-ember-seal",
            contenderIds: ["c-li-yao", "c-su-wan", "c-shen-mo"],
            subjectId: "a-ember-seal",
            objectId: "conflict:a-ember-seal",
            threadId: "t-secret-realm",
          },
        },
        {
          id: "sev-8-2",
          turnNumber: 8,
          type: "conceal-bloodline",
          summary: "Li Yao suppresses a dangerous resonance.",
          payload: { subjectId: "c-li-yao", objectId: "conceal-bloodline", threadId: "t-secret-realm" },
        },
      ],
      activeThreads: fixtureThreads,
      activeTensions: fixtureTensions,
      ensembleState: fixtureEnsemble,
      recentPovIds: [],
      model: fakeDirectorModel(),
    });

    expect(["c-li-yao", "c-su-wan", "c-shen-mo"]).toContain(choice.primaryPovId);
    expect(choice.eventIds).toContain("sev-8-1");
  });

  it("round-trips saved director state snapshots", () => {
    const db = createTestDb();
    try {
      const snapshot: NarrativeDirectorState = {
        activeThreads: [{ id: "t-snapshot", name: "Snapshot Thread", status: "active" }],
        unresolvedSecrets: [{
          id: "ns-snap-secret",
          kind: "secret",
          subjectId: "c-li-yao",
          relatedId: "t-snapshot",
          weight: 1,
          payloadJson: "{\"k\":\"v\"}",
          status: "active",
        }],
        activeTensions: [{
          id: "ns-snap-tension",
          kind: "tension",
          subjectId: "c-su-wan",
          relatedId: "c-shen-mo",
          weight: 0.8,
          payloadJson: "{\"pressure\":true}",
          status: "active",
        }],
        payoffCandidates: [{
          id: "ns-snap-payoff",
          kind: "payoff-candidate",
          subjectId: "a-ember-seal",
          relatedId: "c-li-yao",
          weight: 0.7,
          payloadJson: "{\"arc\":\"seal-awakens\"}",
          status: "active",
        }],
        ensembleHeat: [{ entityId: "c-li-yao", heat: 9 }],
        recentPovIds: ["c-su-wan", "c-li-yao"],
      };
      saveDirectorState(db, snapshot);

      expect(loadDirectorState(db)).toEqual(snapshot);
    } finally {
      db.close();
    }
  });

  it("ignores malformed focus entries when loading saved director snapshots", () => {
    const db = createTestDb();
    try {
      db.prepare(`
        INSERT INTO story_director_state (key, value_json, updated_at)
        VALUES (?, ?, ?)
      `).run("narrative-director", JSON.stringify({
        activeThreads: [{ id: "t-snapshot", name: "Snapshot Thread", status: "active" }],
        unresolvedSecrets: [null, {
          id: "ns-snap-secret",
          kind: "secret",
          subjectId: "c-li-yao",
          relatedId: "t-snapshot",
          weight: 1,
          payloadJson: "{\"k\":\"v\"}",
          status: "active",
        }],
        activeTensions: [],
        payoffCandidates: [],
        ensembleHeat: [{ entityId: "c-li-yao", heat: 9 }],
        recentPovIds: ["c-li-yao"],
      }), Date.now());

      const loaded = loadDirectorState(db);
      expect(loaded.unresolvedSecrets).toHaveLength(1);
      expect(loaded.unresolvedSecrets[0]?.id).toBe("ns-snap-secret");
    } finally {
      db.close();
    }
  });

  it("compacts repeated secret/tension/payoff focus entries when updating from a turn", () => {
    const db = createTestDb();
    try {
      const baseState: NarrativeDirectorState = {
        activeThreads: fixtureThreads,
        unresolvedSecrets: [{
          id: "ns-secret-existing",
          kind: "secret",
          subjectId: "c-li-yao",
          relatedId: "t-secret-realm",
          weight: 1.1,
          payloadJson: "{}",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
        }],
        activeTensions: [{
          id: "ns-tension-existing",
          kind: "tension",
          subjectId: "c-su-wan",
          relatedId: "c-shen-mo",
          weight: 1.2,
          payloadJson: "{}",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
        }],
        payoffCandidates: [{
          id: "ns-payoff-existing",
          kind: "payoff-candidate",
          subjectId: "a-ember-seal",
          relatedId: "c-li-yao",
          weight: 1.3,
          payloadJson: "{}",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
        }],
        ensembleHeat: [],
        recentPovIds: [],
      };

      const updated = updateDirectorStateFromTurn(
        db,
        baseState,
        {
          turnNumber: 9,
          events: [
            {
              id: "sev-9-1",
              turnNumber: 9,
              type: "conceal-bloodline",
              summary: "Duplicate secret focus key",
              payload: { subjectId: "c-li-yao", objectId: "t-secret-realm" },
            },
            {
              id: "sev-9-2",
              turnNumber: 9,
              type: "sect-conflict",
              summary: "Duplicate tension focus key",
              payload: { subjectId: "c-su-wan", objectId: "c-shen-mo" },
            },
            {
              id: "sev-9-3",
              turnNumber: 9,
              type: "artifact-breakthrough",
              summary: "Duplicate payoff focus key",
              payload: { subjectId: "a-ember-seal", objectId: "c-li-yao" },
            },
          ],
          stateChanges: [],
        },
        {
          id: "focus-li-yao",
          score: 1,
          primaryPovId: "c-li-yao",
          eventIds: ["sev-9-1"],
          toneTarget: "tense",
          pacingTarget: "slow",
          hookTarget: "hook",
        },
      );

      expect(updated.unresolvedSecrets).toHaveLength(1);
      expect(updated.unresolvedSecrets[0]?.id).toBe("ns-secret-sev-9-1");
      expect(updated.activeTensions).toHaveLength(1);
      expect(updated.activeTensions[0]?.id).toBe("ns-tension-sev-9-2");
      expect(updated.payoffCandidates).toHaveLength(1);
      expect(updated.payoffCandidates[0]?.id).toBe("ns-payoff-candidate-sev-9-3");
    } finally {
      db.close();
    }
  });
});

const fixtureEvents: StoryResolvedEvent[] = [
  {
    id: "sev-7-1",
    turnNumber: 7,
    type: "conceal-bloodline",
    summary: "Li Yao hides a bloodline surge from elder scrutiny.",
    payload: { subjectId: "c-li-yao", objectId: "t-secret-realm", threadId: "t-secret-realm" },
  },
  {
    id: "sev-7-2",
    turnNumber: 7,
    type: "artifact-conflict",
    summary: "Su Wan and Shen Mo clash over the Ember Seal's resonance.",
    payload: { subjectId: "c-su-wan", objectId: "c-shen-mo", threadId: "t-secret-realm" },
  },
  {
    id: "sev-7-3",
    turnNumber: 7,
    type: "alliance-gesture",
    summary: "Su Wan offers Li Yao a dangerous alliance.",
    payload: { subjectId: "c-su-wan", objectId: "c-li-yao", threadId: "t-secret-realm" },
  },
];

const fixtureTensions: StoryNarrativeSignal[] = [
  {
    id: "ns-1",
    kind: "tension",
    subjectId: "c-su-wan",
    relatedId: "c-shen-mo",
    weight: 0.9,
    payloadJson: JSON.stringify({ source: "artifact-conflict" }),
    status: "active",
  },
];

const fixtureThreads: StoryThread[] = [
  { id: "t-secret-realm", name: "Secret Realm Inheritance", status: "active" },
];

const fixtureEnsemble: EnsembleHeatEntry[] = [
  { entityId: "c-li-yao", heat: 0.95 },
  { entityId: "c-su-wan", heat: 0.8 },
  { entityId: "c-shen-mo", heat: 0.7 },
];

function fakeDirectorModel() {
  return {
    rerankChapterFocus: async (
      candidates: RuntimeChapterSelection[],
      _context: RuntimeNarrativeDirectorInput,
    ): Promise<RuntimeChapterSelection[]> => candidates,
  };
}
