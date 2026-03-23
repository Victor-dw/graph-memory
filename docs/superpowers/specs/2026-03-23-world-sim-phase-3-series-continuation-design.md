# World-Sim Phase 3 Series Continuation Design

Date: 2026-03-23
Status: Draft for review
Project: graph-memory

## Goal

Turn the Phase 2 run-bundle and batch foundations into a practical long-form xianxia writing chain by introducing durable series management, default continuation semantics, and explicit branching from prior runs.

Phase 2 made it possible to:

- run isolated world simulations
- export each run as a durable bundle
- batch multiple independent runs

What is still missing for actual long-form novel production is the layer that answers:

- which run is the latest chapter-producing state of a story
- how to continue writing from that state
- how to branch an alternate future from an earlier run
- how to keep one novel’s runs grouped together instead of treating every run as an isolated experiment

Phase 3 addresses that gap.

## User-Approved Product Decisions

This design locks in the following choices:

- support both `continue` and `branch` modes
- default mode is `continue`
- the continuation unit is a prior run bundle, not an individual chapter
- branching creates a new child series, not a sibling run inside the original series

These decisions deliberately optimize for actual long-form novel workflows while keeping the runtime model understandable.

## Product Direction

Phase 3 adds a **series orchestration layer** above the existing run bundle system.

The system should treat a long-form work as a **series**:

- a series contains an ordered sequence of runs
- each run still exports a full bundle
- runs in the same series represent one evolving storyline
- a branch creates a new descendant series with its own future

This lets the system support both:

1. continuous generation of one novel timeline
2. alternate timelines created from an earlier run

## Why This Direction

The current Phase 2 system is good at producing run artifacts, but it still behaves like an experiment runner.

For automatic novel generation, the primary mental model is not “run 41 versus run 42.” It is:

- this is the main story line
- this is the latest state of that story
- continue from here
- or branch from this past moment into an alternate line

That means Phase 3 should prioritize:

- grouping runs into explicit series
- preserving lineage across continuations
- making branching first-class

Instead of adding more simulation complexity first, the system should now make story progression operable.

## Alternatives Considered

### Option A: Series directory layer over run bundles

Structure story production around explicit series directories:

```text
series/<series-id>/
  series.json
  runs/
    <run-id>/
      index.json
      world-log.jsonl
      chapters/
      state/
```

**Pros**

- obvious filesystem model for one long-form story
- easy to inspect, diff, archive, and branch
- continuation and branching lineage are easy to encode
- builds directly on Phase 2 without replacing it

**Cons**

- introduces another metadata layer
- requires migration from flat `runs/` thinking to series-first thinking

### Option B: Stay flat in `runs/` and encode lineage only in metadata

Keep all runs flat and add `seriesId`, `parentRunId`, and `mode` fields in each run manifest.

**Pros**

- fewer directory changes
- smallest implementation change

**Cons**

- hard to browse manually
- series become conceptual instead of tangible
- branching becomes difficult to read at a glance

### Option C: Database-first series orchestration

Model series and branching primarily in SQLite, with bundles as secondary exports.

**Pros**

- strongest future query surface
- best for large-scale orchestration later

**Cons**

- overbuilds relative to the current need
- makes the filesystem less useful as the primary operational surface

### Recommendation

Use **Option A**.

It matches the user’s actual workflow best: a long-running novel should look like a durable series with inspectable runs, while branches should look like child series.

## Scope Boundaries

Included in Phase 3:

- series directories and series metadata
- default continuation from the latest run in a series
- explicit branching from a chosen run into a child series
- stable lineage metadata between series and runs
- a dedicated high-level CLI for continuous novel production

Not included in Phase 3:

- chapter-level continuation as a first-class input surface
- automatic volume/arc planner
- prose rewriting or editorial polishing
- UI dashboards for series browsing
- automatic branch merging
- fully general snapshot restore for arbitrary external databases

## Core Principle

Keep **simulation truth**, **run artifact export**, and **series orchestration** separate.

- the runtime remains responsible for turn simulation
- the run-bundle layer remains responsible for one run’s exported files
- the new series layer becomes responsible for lineage, continuation mode, and series organization

This keeps Phase 3 additive rather than destabilizing the Phase 2 runtime.

## Proposed Files And Responsibilities

### `src/story/series-cli.ts`

New high-level CLI for long-form production.

Responsibilities:

- parse series-oriented arguments
- choose `continue` or `branch` mode
- resolve source series/run
- orchestrate restore/setup before execution
- call existing runtime and bundle export layers
- update series metadata after a successful run

This should become the preferred command for actual novel production.

### `src/story/series/metadata.ts`

New module for reading/writing `series.json`.

Responsibilities:

- define `StorySeriesMetadata`
- create new series metadata
- load existing series metadata
- append completed run entries
- record branch lineage
- track latest run id
- track run status transitions
- track series-global chapter totals

Keep this pure and focused on series metadata structure.

### `src/story/series/layout.ts`

New module for path resolution.

Responsibilities:

- resolve the series root path
- resolve `series/<series-id>/`
- resolve `series/<series-id>/runs/<run-id>/`
- derive child branch series ids
- centralize naming/layout rules

This prevents CLI logic from hard-coding path behavior.

### `src/story/series/restore.ts`

New module for continuation/branch setup.

Responsibilities:

- load a source run’s exported final world state, belief state, and director state
- prepare the runtime database for the next run
- rehydrate canonical world truth, subjective belief state, and director state before execution

This is the main new runtime bridge in Phase 3.

### Existing modules reused

- `src/story/runtime/run-loop.ts`
- `src/story/output/run-bundle.ts`
- `src/story/cli.ts`
- `src/story/batch-cli.ts`
- `src/story/world-state.ts`
- `src/store/db.ts`

Phase 3 should build on these rather than replace them.

## Directory Model

### Series layout

Recommended structure:

```text
series/<series-id>/
  series.json
  runs/
    <run-id>/
      index.json
      world-log.jsonl
      chapters/
      state/
```

### Why not reuse flat `runs/`

Phase 2 flat runs are still useful for isolated experiments. Phase 3 should preserve that.

But the new high-level continuation workflow should default to the series layout because:

- it groups one novel’s runs together
- it makes branching visually obvious
- it avoids mixing unrelated experiments with production chains

## Data Model

### `series.json`

At minimum:

- `schemaVersion`
- `seriesId`
- `type`
  - `mainline`
  - `alternate`
- `mode`
  - `root`
  - `branch`
- `createdAt`
- `updatedAt`
- `parentSeriesId` if branched
- `branchedFromRunId` if branched
- `latestRunId`
- `runCount`
- `totalChapterCount`
- `runs`
  - ordered list of run summaries

Each run summary should include:

- `runId`
- `startedAt`
- `finishedAt`
- `turnCount`
- `chapterCount`
- `path`
- `status`
  - `running`
  - `success`
  - `failed`
- `seriesChapterStart`
- `seriesChapterEnd`
- `continuedFromRunId` if applicable

Only runs with `status=success` may become `latestRunId`.
Failed or partial runs must remain visible for diagnostics but must not advance the canonical continuation pointer.

`latestRunId` should be nullable until the series records its first successful run.
That allows the system to represent:

- a newly created root series with no runs yet
- a series whose attempted initial run failed

For such series:

- `latestRunId = null`
- `runCount` may still be greater than zero if failed attempts are recorded
- `story:series --mode=continue` should treat the next successful run as the first canonical continuation point rather than trying to restore from a missing prior success

### Child series naming

Child series ids should be readable and stable for humans browsing the filesystem.

Recommended rule:

- keep the directory series id short, for example `<parent-series-id>-branch-01`
- store full lineage detail in metadata rather than encoding everything into the folder name

Required lineage fields:

- `parentSeriesId`
- `branchedFromRunId`
- `createdAt`

This keeps the filesystem readable while still making branches fully traceable.

### Run bundle manifest additions

Existing `index.json` should be extended in Phase 3 to carry lineage metadata useful outside the series file:

- `seriesId`
- `seriesMode`
- `continuedFromRunId`
- `branchedFromRunId`
- `parentSeriesId`

This keeps each run bundle self-describing even if copied elsewhere.

## Runtime Semantics

### Continue mode

Default behavior:

- target a series
- find that series’s `latestRunId`
- restore world state from the source run’s `state/final-world.json`
- restore belief state from the source run’s `state/final-beliefs.json`
- restore director state from `state/final-director.json`
- continue the story by running the requested number of turns
- export a new run bundle into the same series
- update `series.json`

`continue` must remain a single-line forward progression within one series.
Because of that, `continue` should only target the latest run of the series.

If the user supplies `--from-run` and it is not the latest run for that series, the command must not append a new run to that same series. The system should either:

- reject the request with a clear error, or
- require the caller to switch to `--mode=branch`

Phase 3 should choose the stricter rule:

- `continue` accepts only the latest run
- branching from any earlier run requires explicit `--mode=branch`

### Branch mode

Explicit behavior:

- choose a source series and source run
- create a child series id
- initialize a new series directory
- restore world state and director state from the source run
- restore belief state from the source run
- execute the requested number of turns
- write the new run into the child series
- record lineage in both the child series metadata and the new run manifest

Branch mode should not mutate the source series.

CLI rule:

- `--mode=branch` requires `--from-run`

## Rehydration Strategy

Phase 3 needs a practical restore path from exported state back into the runtime DB.

Recommended MVP strategy:

1. create/open the configured story DB
2. clear story runtime state
3. re-seed canonical entities and relations from exported `final-world.json`
4. re-seed subjective beliefs from exported `final-beliefs.json`
5. re-seed persisted director state from exported `final-director.json`
6. begin new turns from the restored state

Important note:

This means the exported continuation snapshot must be treated as a sufficiently complete restore contract, not merely a debugging export.

The current Phase 2 `final-world.json` is not yet sufficient because it omits subjective belief state, even though belief state is core to the approved system model and to turn execution.

Phase 3 should therefore explicitly expand the continuation snapshot contract.

Minimum continuation snapshot contents:

- canonical entities
- canonical relations
- active threads
- narrative signals
- subjective character beliefs
- any persisted faction-level belief state if present
- director state snapshot

Recommended contract:

- keep `state/final-world.json` for canonical world truth
- add `state/final-beliefs.json` for subjective belief state
- keep `state/final-director.json` for narrative director state

Restore targets should be explicitly defined as:

- `story_entities`
- `story_relations`
- `story_beliefs`
- `story_director_state`
- any other persisted narrative tables required for continuity-preserving recall and turn simulation

Phase 3 should prefer expanding the exported restore surface over inventing a hidden restore-only format.

## CLI Design

### New command

Recommended entrypoint:

```bash
npm run story:series -- --series=my-mainline --turns=6 --stub-model
```

Default semantics:

- mode defaults to `continue`
- if the series does not yet exist, create it as a root series
- otherwise continue from its latest run

### Explicit branch example

```bash
npm run story:series -- --series=my-mainline --mode=branch --from-run=<run-id> --turns=6 --stub-model
```

This should create a child series rather than appending to `my-mainline`.

### Suggested arguments

- `--series=<series-id>`
- `--series-root=<path>`
- `--mode=continue|branch`
- `--from-run=<run-id>`
- `--turns=<n>`
- `--stub-model`

The Phase 3 CLI should default its series root area to:

```text
./series
```

so the resulting series layout becomes:

```text
./series/<series-id>/runs/<run-id>/
```

`--series-root` should override that default so multiple novel projects can keep separate series trees.

Phase 3 should not carry over the Phase 2 `--output-dir` argument into `story:series`.

Reason:

- `story:series` is series-oriented, not run-bundle-root-oriented
- run bundles should always live under `<series-root>/<series-id>/runs/<run-id>/`
- keeping both `--series-root` and `--output-dir` would create two competing path controls for the same artifact

So the Phase 3 CLI contract should be:

- `story:run` and `story:batch` continue using `--output-dir`
- `story:series` uses `--series-root` instead

### Reset semantics

`story:series` must not allow restored continuation state to be silently cleared by the runtime reset path.

Phase 3 should make this rule explicit:

- `story:series` restores prior state first
- continuation/branch runs then execute with `resetOnStart=false`
- if explicit clearing is ever needed for a root-series bootstrap flow, it should be a series-layer decision before restore, not something delegated to `runStoryLoop()` after restore

This avoids conflicts with the current Phase 2 reset behavior and keeps the series CLI authoritative over continuation semantics.

## Error Handling

### Missing source run

If `--from-run` is provided but cannot be found:

- fail clearly
- do not create a partial new run

### Invalid mode/argument combinations

If the caller passes:

- `--mode=branch` without `--from-run`
- `--mode=continue` with a non-latest `--from-run`

the CLI should fail clearly before any restore or execution work begins.

If the caller runs `story:series --mode=continue` against an existing series whose `latestRunId` is still `null`, the CLI should:

- treat the run as that series’s first successful canonical run
- skip restore because there is no prior successful continuation point
- keep failed historical attempts visible in metadata without treating them as continuation sources

### Corrupt source bundle

If required restore files are missing or malformed:

- fail before execution starts
- surface which file is invalid
- do not write partial series metadata

### Branch creation failure

If child series metadata creation succeeds but the actual run fails:

- keep the new child series directory only if it contains diagnostically useful metadata
- avoid writing misleading `latestRunId`

### Continuation failure after restore

If restore succeeds but execution fails:

- preserve the source series unchanged
- do not claim a new latest run

## Testing Strategy

Phase 3 should cover four categories:

### 1. Series metadata tests

Verify:

- root series creation
- latest run tracking
- latest run ignores failed runs
- child series lineage metadata
- total chapter count updates across successful runs

### 2. Restore tests

Verify:

- a run’s exported `final-world.json` can rehydrate the runtime DB
- a run’s exported `final-beliefs.json` can rehydrate subjective belief state
- a restored director state is reused by the next run

### 3. CLI integration tests

Verify:

- `continue` creates a second run in the same series
- default continuation picks the latest run
- `continue` rejects a non-latest `--from-run`
- `branch` creates a child series
- `branch` requires `--from-run`
- branch does not mutate the source series

### 4. End-to-end continuity tests

Verify:

- run numbering grows across continuations within a series
- series-global chapter progression grows across continuations via metadata
- a branch starting from run N diverges while preserving the original lineage

Important numbering rule:

- run bundle chapter filenames remain per-run (`chapter-001.md`, `chapter-002.md`, ...)
- Phase 2 bundle format should remain stable
- series-global chapter continuity should therefore be tracked in series metadata and optionally in run manifest fields such as `seriesChapterStart` / `seriesChapterEnd`

Phase 3 should not silently redefine bundle-local chapter ordinals to be series-global unless that is made an explicit later-phase migration.

## Success Criteria

Phase 3 is complete when:

- a user can create a root series and continue it repeatedly
- the system can branch from an earlier run into a child series
- each continued or branched run still exports a complete run bundle
- lineage is readable from the filesystem alone
- failed runs do not become the latest continuation point
- series-global chapter totals advance only on successful runs
- README and CLI behavior make the long-form workflow understandable without code reading

## Recommended Next Step

If this design is approved, the implementation plan should split the work into:

1. series metadata and layout
2. restore/rehydration path
3. `story:series` CLI
4. continuation tests
5. branch tests
6. documentation and final verification
