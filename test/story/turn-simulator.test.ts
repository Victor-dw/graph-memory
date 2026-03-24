import { describe, expect, it, vi } from "vitest";
import { createSeedWorld } from "../../src/story/bootstrap.ts";
import { createStoryWorldState } from "../../src/story/world-state.ts";
import { runStoryTurn, type StoryTurnInput } from "../../src/story/turn-simulator.ts";
import type { ActorDecisionInput, StoryAction } from "../../src/story/runtime/model-client.ts";
import { createTestDb } from "../helpers.ts";

describe("story turn simulator", () => {
  it("advances one turn and records resolved events", async () => {
    const db = createTestDb();
    try {
      const world = createStoryWorldState(db);
      world.saveSeed(createSeedWorld());

      const seedContext: StoryTurnInput = {
        turnNumber: 1,
        model: {
          rerankActorActions: async (actions: StoryAction[]) => actions,
          rerankFactionActions: async (actions: StoryAction[]) => actions,
        },
      };

      const result = await runStoryTurn(db, seedContext);

      expect(result.turnNumber).toBe(1);
      expect(result.events.length).toBeGreaterThan(0);
      expect(result.stateChanges.length).toBeGreaterThan(0);

      const turnRow = db.prepare("SELECT turn_number FROM story_turns WHERE turn_number = 1").get() as
        | { turn_number: number }
        | undefined;
      expect(turnRow?.turn_number).toBe(1);

      const eventCount = (db.prepare("SELECT COUNT(*) as c FROM story_events WHERE turn_number = 1").get() as
        { c: number }).c;
      expect(eventCount).toBe(result.events.length);

      const ledgerCount = (db.prepare("SELECT COUNT(*) as c FROM story_event_ledger WHERE turn_number = 1").get() as
        { c: number }).c;
      expect(ledgerCount).toBe(result.events.length);
    } finally {
      db.close();
    }
  });

  it("creates conflicts when competing actions target the same artifact", async () => {
    const db = createTestDb();
    try {
      const world = createStoryWorldState(db);
      world.saveSeed(createSeedWorld());

      const conflictFixture: StoryTurnInput = {
        turnNumber: 2,
        model: {
          rerankActorActions: async (actions: StoryAction[], context?: ActorDecisionInput) =>
            forceConflictFixtureActorActions(actions, context),
          rerankFactionActions: async (actions: StoryAction[]) => actions,
        },
      };

      const result = await runStoryTurn(db, conflictFixture);

      expect(result.events.some((event) => event.type === "artifact-conflict")).toBe(true);
      expect(result.events.some((event) => event.type === "conceal-bloodline")).toBe(true);
      expect(result.events.some((event) => event.type === "train-breakthrough")).toBe(true);

      const conflictRow = db.prepare(`
        SELECT payload
        FROM story_events
        WHERE turn_number = 2 AND type = 'artifact-conflict'
      `).get() as { payload: string } | undefined;
      expect(conflictRow).toBeDefined();
      expect(conflictRow?.payload).toContain("\"contenderIds\"");
      expect(conflictRow?.payload).toContain("\"predicate\":\"IN_CONFLICT\"");
      expect(conflictRow?.payload).not.toContain("\"predicate\":\"CONTESTED_BY\"");
    } finally {
      db.close();
    }
  });

  it("rolls back turn persistence atomically when signal persistence fails", async () => {
    const db = createTestDb();
    try {
      const world = createStoryWorldState(db);
      world.saveSeed(createSeedWorld());
      db.exec(`
        CREATE TRIGGER story_signal_insert_blocker
        BEFORE INSERT ON story_narrative_signals
        BEGIN
          SELECT RAISE(ABORT, 'signal-insert-blocked');
        END;
      `);

      await expect(runStoryTurn(db, {
        turnNumber: 3,
        model: {
          rerankActorActions: async (actions: StoryAction[]) => actions,
          rerankFactionActions: async (actions: StoryAction[]) => actions,
        },
      })).rejects.toThrowError(/signal-insert-blocked/);

      const turnCount = (db.prepare("SELECT COUNT(*) as c FROM story_turns WHERE turn_number = 3").get() as
        { c: number }).c;
      const eventCount = (db.prepare("SELECT COUNT(*) as c FROM story_events WHERE turn_number = 3").get() as
        { c: number }).c;
      const relationCount = (db.prepare(`
        SELECT COUNT(*) as c
        FROM story_relations
        WHERE source_event_id LIKE 'sev-3-%'
      `).get() as { c: number }).c;
      const threadStateCount = (db.prepare(`
        SELECT COUNT(*) as c
        FROM story_thread_state
        WHERE last_advanced_turn = 3
      `).get() as { c: number }).c;

      expect(turnCount).toBe(0);
      expect(eventCount).toBe(0);
      expect(relationCount).toBe(0);
      expect(threadStateCount).toBe(0);
    } finally {
      db.close();
    }
  });

  it("does not create artifact conflicts from fortify-secret-realm alone", async () => {
    const db = createTestDb();
    try {
      const world = createStoryWorldState(db);
      world.saveSeed(createSeedWorld());

      const result = await runStoryTurn(db, {
        turnNumber: 4,
        model: {
          rerankActorActions: async (actions: StoryAction[]) => preferNoArtifactSeek(actions),
          rerankFactionActions: async (actions: StoryAction[]) => preferFortify(actions),
        },
      });

      expect(result.events.some((event) => event.type === "artifact-conflict")).toBe(false);
      expect(result.events.some((event) => event.type === "fortify-secret-realm")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("stores artifact conflict beliefs as an aggregate fact instead of a single contender claim", async () => {
    const db = createTestDb();
    try {
      const world = createStoryWorldState(db);
      world.saveSeed(createSeedWorld());

      await runStoryTurn(db, {
        turnNumber: 5,
        model: {
          rerankActorActions: async (actions: StoryAction[]) => forceSeekArtifact(actions),
          rerankFactionActions: async (actions: StoryAction[]) => actions,
        },
      });

      const conflictBelief = db.prepare(`
        SELECT subject_id, predicate, object_id
        FROM story_beliefs
        WHERE actor_id = ? AND subject_id = ? AND predicate = ?
      `).get("c-li-yao", "a-ember-seal", "IN_CONFLICT") as
        | { subject_id: string; predicate: string; object_id: string }
        | undefined;
      const lossyBelief = db.prepare(`
        SELECT subject_id, predicate, object_id
        FROM story_beliefs
        WHERE actor_id = ? AND subject_id = ? AND predicate = ?
      `).get("c-li-yao", "a-ember-seal", "CONTESTED_BY") as
        | { subject_id: string; predicate: string; object_id: string }
        | undefined;

      expect(conflictBelief).toEqual({
        subject_id: "a-ember-seal",
        predicate: "IN_CONFLICT",
        object_id: "conflict:a-ember-seal",
      });
      expect(lossyBelief).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("upserts repeated execute relations and signals instead of appending duplicates forever", async () => {
    const db = createTestDb();
    try {
      const world = createStoryWorldState(db);
      world.saveSeed(createSeedWorld());

      for (const turnNumber of [6, 7]) {
        await runStoryTurn(db, {
          turnNumber,
          model: {
            rerankActorActions: async (actions: StoryAction[]) =>
              reorderActions(actions, ["conceal-bloodline", "train-breakthrough"]),
            rerankFactionActions: async (actions: StoryAction[]) =>
              reorderActions(actions, ["fortify-secret-realm", "mediate-inheritance-dispute"]),
          },
        });
      }

      const relationCount = (db.prepare(`
        SELECT COUNT(*) AS c
        FROM story_relations
        WHERE from_id = ? AND relation = ? AND to_id = ?
      `).get("c-li-yao", "EXECUTES", "conceal-bloodline") as { c: number }).c;
      const signalCount = (db.prepare(`
        SELECT COUNT(*) AS c
        FROM story_narrative_signals
        WHERE kind = ? AND subject_id = ? AND related_id = ?
      `).get("conceal-bloodline", "c-li-yao", "conceal-bloodline") as { c: number }).c;
      const canonicalExecutesCount = (db.prepare(`
        SELECT COUNT(*) AS c
        FROM story_state_relations
        WHERE relation = 'EXECUTES'
      `).get() as { c: number }).c;

      expect(relationCount).toBe(1);
      expect(signalCount).toBe(1);
      expect(canonicalExecutesCount).toBe(0);
    } finally {
      db.close();
    }
  });

  it("projects non-EXECUTES canonical relations from artifact-seek events", async () => {
    const db = createTestDb();
    try {
      const world = createStoryWorldState(db);
      world.saveSeed(createSeedWorld());

      await runStoryTurn(db, {
        turnNumber: 11,
        model: {
          rerankActorActions: async (actions: StoryAction[], context?: ActorDecisionInput) =>
            forceSingleArtifactSeeker(actions, context),
          rerankFactionActions: async (actions: StoryAction[]) => actions,
        },
      });

      const soughtByCount = (db.prepare(`
        SELECT COUNT(*) AS c
        FROM story_state_relations
        WHERE relation = 'SOUGHT_BY'
      `).get() as { c: number }).c;
      const mirroredActorIdentity = db.prepare("SELECT id FROM story_identities WHERE id = ?")
        .get("c-li-yao") as { id: string } | undefined;
      const mirroredArtifactIdentity = db.prepare("SELECT id FROM story_identities WHERE id = ?")
        .get("a-ember-seal") as { id: string } | undefined;

      expect(soughtByCount).toBeGreaterThan(0);
      expect(mirroredActorIdentity?.id).toBe("c-li-yao");
      expect(mirroredArtifactIdentity?.id).toBe("a-ember-seal");
    } finally {
      db.close();
    }
  });

  it("projects conflict aggregates and synthesizes conflict identities for canonical state", async () => {
    const db = createTestDb();
    try {
      const world = createStoryWorldState(db);
      world.saveSeed(createSeedWorld());

      await runStoryTurn(db, {
        turnNumber: 12,
        model: {
          rerankActorActions: async (actions: StoryAction[], context?: ActorDecisionInput) =>
            forceConflictFixtureActorActions(actions, context),
          rerankFactionActions: async (actions: StoryAction[]) => actions,
        },
      });

      const projectedConflictRelation = db.prepare(`
        SELECT from_identity_id, relation, to_identity_id
        FROM story_state_relations
        WHERE relation = 'IN_CONFLICT' AND from_identity_id = 'a-ember-seal'
      `).get() as
        | { from_identity_id: string; relation: string; to_identity_id: string }
        | undefined;
      const conflictIdentity = db.prepare(`
        SELECT id, kind
        FROM story_identities
        WHERE id = 'conflict:a-ember-seal'
      `).get() as
        | { id: string; kind: string }
        | undefined;

      expect(projectedConflictRelation).toEqual({
        from_identity_id: "a-ember-seal",
        relation: "IN_CONFLICT",
        to_identity_id: "conflict:a-ember-seal",
      });
      expect(conflictIdentity).toEqual({
        id: "conflict:a-ember-seal",
        kind: "thread",
      });
    } finally {
      db.close();
    }
  });

  it("warns once when a non-EXECUTES projection endpoint cannot be resolved", async () => {
    const db = createTestDb();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const world = createStoryWorldState(db);
      world.saveSeed(createSeedWorld());
      db.prepare("DELETE FROM story_entities WHERE id = ?").run("a-ember-seal");

      await runStoryTurn(db, {
        turnNumber: 13,
        model: {
          rerankActorActions: async (actions: StoryAction[], context?: ActorDecisionInput) =>
            forceSingleArtifactSeeker(actions, context),
          rerankFactionActions: async (actions: StoryAction[]) => actions,
        },
      });

      const projectedCount = (db.prepare(`
        SELECT COUNT(*) AS c
        FROM story_state_relations
        WHERE relation = 'SOUGHT_BY'
      `).get() as { c: number }).c;

      expect(projectedCount).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(
        "[story-projection] skipped projected relation due to unresolved identity endpoints",
        expect.objectContaining({
          relation: "SOUGHT_BY",
          fromIdentityId: "a-ember-seal",
          toIdentityId: "c-li-yao",
        }),
      );
    } finally {
      warnSpy.mockRestore();
      db.close();
    }
  });

  it("escalates repeated artifact contention into an artifact-showdown event", async () => {
    const db = createTestDb();
    try {
      const world = createStoryWorldState(db);
      world.saveSeed(createSeedWorld());

      for (const turnNumber of [8, 9, 10]) {
        await runStoryTurn(db, {
          turnNumber,
          model: {
            rerankActorActions: async (actions: StoryAction[]) => forceSeekArtifact(actions),
            rerankFactionActions: async (actions: StoryAction[]) => actions,
          },
        });
      }

      const showdownRow = db.prepare(`
        SELECT type, payload
        FROM story_events
        WHERE turn_number = 10 AND type = 'artifact-showdown'
      `).get() as { type: string; payload: string } | undefined;
      const threadStateRow = db.prepare(`
        SELECT ts.stage, ts.last_advanced_turn, ts.last_event_id, el.event_type
        FROM story_thread_state ts
        LEFT JOIN story_event_ledger el ON el.id = ts.last_event_id
        WHERE ts.thread_id = 't-secret-realm'
      `).get() as
        | { stage: string; last_advanced_turn: number; last_event_id: string; event_type: string }
        | undefined;
      const threadStateRowCount = (db.prepare(`
        SELECT COUNT(*) AS c
        FROM story_thread_state
        WHERE thread_id = 't-secret-realm'
      `).get() as { c: number }).c;

      expect(showdownRow?.type).toBe("artifact-showdown");
      expect(showdownRow?.payload).toContain("\"conflictId\":\"conflict:a-ember-seal\"");
      expect(threadStateRowCount).toBe(1);
      expect(threadStateRow).toEqual({
        stage: "showdown",
        last_advanced_turn: 10,
        last_event_id: expect.stringContaining("sle-sev-10-"),
        event_type: "artifact-showdown",
      });
    } finally {
      db.close();
    }
  });
});

function forceSeekArtifact(actions: StoryAction[]): StoryAction[] {
  const seek = actions.filter((action) => action.type === "seek-artifact");
  return seek.length > 0 ? [...seek, ...actions.filter((action) => action.type !== "seek-artifact")] : actions;
}

function forceConflictFixtureActorActions(
  actions: StoryAction[],
  context?: ActorDecisionInput,
): StoryAction[] {
  if (context?.actorId === "c-li-yao") {
    return reorderActions(actions, ["seek-artifact", "conceal-bloodline"]);
  }
  if (context?.actorId === "c-su-wan") {
    return reorderActions(actions, ["seek-artifact", "train-breakthrough"]);
  }
  return actions;
}

function forceSingleArtifactSeeker(actions: StoryAction[], context?: ActorDecisionInput): StoryAction[] {
  if (context?.actorId === "c-li-yao") {
    return reorderActions(actions, ["seek-artifact"]);
  }
  return preferNoArtifactSeek(actions);
}

function preferNoArtifactSeek(actions: StoryAction[]): StoryAction[] {
  const nonSeek = actions.filter((action) => action.type !== "seek-artifact");
  const seek = actions.filter((action) => action.type === "seek-artifact");
  return [...nonSeek, ...seek];
}

function preferFortify(actions: StoryAction[]): StoryAction[] {
  const fortify = actions.filter((action) => action.type === "fortify-secret-realm");
  return fortify.length > 0
    ? [...fortify, ...actions.filter((action) => action.type !== "fortify-secret-realm")]
    : actions;
}

function reorderActions(actions: StoryAction[], preferredTypes: string[]): StoryAction[] {
  const preferred = preferredTypes.flatMap((type) => actions.filter((action) => action.type === type));
  const preferredIds = new Set(preferred.map((action) => action.id));
  return [...preferred, ...actions.filter((action) => !preferredIds.has(action.id))];
}
