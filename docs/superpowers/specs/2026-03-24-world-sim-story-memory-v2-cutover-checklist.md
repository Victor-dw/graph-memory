# World-Sim Story Memory V2 Cutover Checklist

Date: 2026-03-24
Status: Working cutover checklist
Project: graph-memory

## Purpose

This document defines the practical endgame for `story memory schema v2`.

It answers four questions:

1. what is already stable
2. what still depends on dual-write
3. what must be true before we reduce legacy dependence
4. what the next controlled steps should be

## Current Verified State

The branch has now passed:

- focused Task 6 verification
- focused Task 7 verification
- full test suite
- full TypeScript build
- live MiniMax smoke
- a 3-run live soak
- a 6-run live soak

Observed current behavior:

- continuation restore is stable
- run bundles are stable
- `final-world.json`, `final-beliefs.json`, and `final-director.json` are present and strict
- projected schema v2 state is exported and restored
- recall and chapter packet assembly consume projected story memory

## Current Measured Memory Shape

Recent live soak bundles consistently show:

- `relations = 848`
- `projectedRelations = 1`
- `threadState = 1`
- `identities = 2`
- `executes_in_projected = 0`
- `executes_in_legacy = 740`
- `consistency_issues = 0`

Interpretation:

- schema v2 projected memory is staying clean
- legacy `story_relations` is still residue-heavy
- dual-write is still useful because old compatibility surfaces exist and the old tables remain noisy

## What Is Already Safe To Treat As Canonical

These are now strong enough to be treated as the preferred read path:

- `story_event_ledger` for durable event history
- `story_state_relations` for current durable relation state
- `story_thread_state` for explicit thread progression
- schema v2-backed recall packet assembly
- schema v2-backed chapter packet assembly
- schema v2-backed continuation snapshot payloads

## What Still Should Not Be Trusted As Canonical

These should remain compatibility-only for now:

- raw legacy `story_relations` as a source of durable truth
- raw repeated `EXECUTES` residue
- legacy-only world-state interpretation without schema v2 cross-checks

## Dual-Write Recommendation

Keep `dual-write` on for now.

Reason:

- projected state is clean but still narrow
- legacy compatibility is still required for some restore and snapshot fallback paths
- current soak data proves stability, not yet completeness of schema v2 coverage

## Exit Criteria Before Reducing Legacy Dependence

Do not reduce dual-write until all of the following are true:

- at least one longer soak beyond the current 6-run verification still passes without restore drift
- projected relation coverage is no longer trivially tiny compared with the durable facts we expect to preserve
- no critical runtime path still requires legacy `story_relations` for correctness
- snapshot restore can rebuild a valid continuation state from schema v2 exports without relying on legacy residue-heavy relations
- recall quality remains stable when legacy relation fallback is reduced
- chapter quality remains stable across multiple continuation runs

## Recommended Controlled Next Steps

### Step 1: Hold the line

Keep the current architecture:

- continue dual-write
- prefer schema v2 reads where already migrated
- keep legacy compatibility in restore and snapshot fallback

### Step 2: Expand schema v2 coverage

The next valuable work is not more blind soak first.
It is to widen the useful projected surface.

Priority candidates:

- project more durable relation consequences into `story_state_relations`
- add richer canonical identity coverage, including alias export where appropriate
- introduce projected stat/state tables only if they will actually be consumed by recall or consistency

### Step 3: Add one more staged gate before cutover

Before any real cutover:

- run another longer soak
- compare first bundle vs latest bundle memory counts
- compare chapter quality and continuity manually across several runs
- verify no new projected `EXECUTES` leakage appears

### Step 4: Only then consider read-path tightening

The first cutover move should be small:

- reduce legacy fallback in selected read paths
- do not remove snapshot compatibility yet
- do not remove dual-write yet

## Practical Decision

If we had to decide today:

- **Do not fully shift to schema v2-only reads yet**
- **Do keep dual-write**
- **Do treat the current branch as stable enough for further memory-quality iteration**

## Closing Assessment

This branch is no longer in the risky "can it even survive continuation" phase.

It is now in the higher-value final phase:

- improving memory quality
- increasing schema v2 coverage
- planning a careful cutover instead of a premature one

That means the project is close to architectural closure, but not yet at the point where legacy compatibility should be removed.
