# AGENTS.md

## Purpose

This repository is being adapted into a long-form xianxia / cultivation novel runtime.

The current branch goal is:

- keep long-run continuation stable
- keep schema v2 story memory clean
- preserve compatibility while legacy `story_*` tables are still noisy

This file is the maintenance guide for future agents working in this repo.

## Product Direction

The active product goal is **not** "restore OpenClaw plugin behavior."

The active goal is:

- use graph-backed memory to support automatic long-form xianxia / cultivation fiction
- preserve character relationships, plot continuity, thread progression, and important item / identity links across many continuation runs
- improve durable narrative memory quality without destabilizing long-run execution

Practical implication:

- treat `story/` as the primary product surface
- do not optimize for OpenClaw-specific integration unless explicitly requested
- prefer decisions that improve multi-run narrative continuity over legacy plugin aesthetics

## Current Status

Current branch has already verified:

- Task 6 complete: recall and chapter packets prefer projected story memory
- Task 7 complete: schema v2 snapshot export / restore works
- compatibility hardening complete for schema v2 snapshot fallback
- full test suite passes
- TypeScript build passes
- live MiniMax smoke passes
- 3-run live soak passes
- 6-run live soak passes
- 24h supervised soak passes
- long-run session failures are classified in controller state
- malformed chapter/faction ranking responses degrade to original-order fallback instead of failing the whole iteration
- transient network `fetch failed` provider errors are retried

Practical conclusion:

- the branch is stable enough for trial production
- the branch is suitable for supervised internal production runs
- the branch is not yet proven for unattended 24h cutover as the only production path
- it is not yet ready for removing legacy compatibility
- keep `dual-write`

Current best reading of readiness:

- yes for supervised generation, iterative authoring, and further soak validation
- no for "remove fallback and trust schema v2 alone everywhere"
- no for fully unattended cutover without another post-hardening soak
- no for committing secrets or hard-coding provider credentials into repo files

## Core Rule

Do **not** treat legacy `story_relations` as canonical story truth.

Observed live state has repeatedly shown:

- `relations = 848`
- `EXECUTES` residue dominates legacy relations
- schema v2 `projectedRelations` stays clean

Preferred canonical read surfaces:

- durable event history: `story_event_ledger`
- current durable relations: `story_state_relations`
- thread progression: `story_thread_state`
- continuation snapshots carrying schema v2 state

Legacy surfaces are compatibility-only unless explicitly proven otherwise.

## Source Layout

Important source files:

- `src/story/runtime/model-client.ts`
- `src/story/series-cli.ts`
- `src/story/long-run-cli.ts`
- `src/story/memory/recall.ts`
- `src/story/narrative/chapter-generator.ts`
- `src/story/memory/consistency.ts`
- `src/story/world-state.ts`
- `src/story/output/run-bundle.ts`
- `src/story/series/restore.ts`
- `src/story/memory/schema-v2.ts`
- `src/story/memory/event-ledger.ts`
- `src/story/memory/projection.ts`
- `src/story/memory/thread-state.ts`
- `src/story/memory/director-focus.ts`

Important tests:

- `test/story/memory-recall.test.ts`
- `test/story/chapter-generator.test.ts`
- `test/story/consistency.test.ts`
- `test/story/run-bundle.test.ts`
- `test/story/series-cli.test.ts`
- `test/story/series-restore.test.ts`
- `test/story/schema-v2-store.test.ts`
- `test/story/thread-state.test.ts`
- `test/story/turn-simulator.test.ts`

Important design docs:

- `docs/superpowers/specs/2026-03-24-world-sim-story-memory-v2-design.md`
- `docs/superpowers/plans/2026-03-24-world-sim-story-memory-v2.md`
- `docs/superpowers/specs/2026-03-24-world-sim-story-memory-v2-cutover-checklist.md`

## Runtime Commands

Main commands:

- `npm test`
- `npm run build`
- `npm run story:run -- ...`
- `npm run story:series -- ...`
- `npm run story:long-run -- ...`

Common long-run helper:

- `.local/run-minimax-24h.sh`

Typical long-run usage:

```bash
npm run story:long-run -- \
  --series=xianxia-mainline \
  --series-root=.local/series-24h \
  --turns=3 \
  --duration-hours=24 \
  --cooldown-seconds=5 \
  --label=minimax-24h
```

## Generated vs Source-Of-Truth

Treat these as generated runtime artifacts, not authored source:

- `.local/`
- `.local/series-*`
- `.local/*.env`
- `runs/`

Rules:

- do not hand-edit run bundles unless a test explicitly needs fixture corruption
- do not commit runtime output directories
- do not commit `.env` files, provider keys, or local runtime credentials
- do not use generated runtime state as the only source of architectural truth

Treat these as authored source of truth:

- `src/`
- `test/`
- committed docs under `docs/`
- this `AGENTS.md`

## Verified Schema V2 Surfaces

Current stable schema v2 behavior:

- ledger writes happen through `src/story/memory/event-ledger.ts`
- projected relations are maintained through `src/story/memory/projection.ts`
- thread advancement is maintained through `src/story/memory/thread-state.ts`
- recall prefers projected relations and filters out `EXECUTES`
- chapter packets include thread-state summaries
- `final-world.json` exports:
  - legacy-compatible `relations`
  - schema v2 `identities`
  - schema v2 `projectedRelations`
  - schema v2 `threadState`
- restore accepts dual-format snapshots and remains strict on required files

Important behavior constraints:

- keep `EXECUTES` out of projected canonical memory
- preserve snapshot strictness for required files
- allow optional schema v2 snapshot sections to be omitted for compatibility
- do not remove legacy fallback in one jump

## Working Rules

When touching story memory:

- prefer small, controlled changes
- do not do a global cutover without a staged plan
- do not remove `dual-write` casually
- do not remove legacy fallback unless a specific path has been verified in isolation

When touching continuation:

- preserve required files:
  - `final-world.json`
  - `final-beliefs.json`
  - `final-director.json`
- keep restore fail-fast behavior for missing or invalid required snapshots
- a brand-new series with no `latestRunId` must start from a fresh seeded world at turn `1`, even if `NOVEL_DB_PATH` points at a reused/shared SQLite file
- only continuation or branch runs may inherit prior world state through bundle restore

When touching projected state:

- do not let legacy residue leak back into `story_state_relations`
- do not reintroduce projected `EXECUTES`

When touching model runtime or provider wiring:

- keep provider configuration externalized through local env or runtime config
- never check API keys, tokens, or copied provider snippets into tracked files
- verify failure behavior is survivable for long-run loops before calling a provider integration "done"
- preserve typed failure outcomes in `summary.json` / `events.jsonl`
- `llm_empty_content` is an intentional classified failure mode, not a silent success case
- malformed chapter/faction ranking responses should remain observable via warnings even when they no longer fail an iteration

## Verification Gate

Before claiming completion, always run:

```bash
npm test
npm run build
```

When changing recall / chapter packet / consistency:

```bash
npx vitest run \
  test/story/memory-recall.test.ts \
  test/story/chapter-generator.test.ts \
  test/story/consistency.test.ts \
  test/story/turn-simulator.test.ts \
  test/story/thread-state.test.ts
```

When changing snapshot export / restore:

```bash
npx vitest run \
  test/story/run-bundle.test.ts \
  test/story/series-restore.test.ts \
  test/story/schema-v2-store.test.ts
```

When changing provider/runtime hardening or long-run recovery:

```bash
npx vitest run \
  test/story/cli.test.ts \
  test/story/long-run-cli.test.ts
```

If making a cutover decision, also inspect latest bundle metrics:

- total legacy `relations`
- total `projectedRelations`
- `EXECUTES` count in projected vs legacy
- `threadState`
- `consistency_issues`
- `summary.json:lastFailureCode`
- `events.jsonl:run-failed.failureCode`

## Cutover Guidance

Current recommendation:

- keep `dual-write`
- keep schema v2 as preferred read surface where already migrated
- keep legacy compatibility in snapshot restore

Do not move to schema v2-only reads until:

- another controlled longer soak still passes
- projected relation coverage is meaningfully broader
- a specific fallback path is removed intentionally and re-verified

Preferred next-step style:

1. pick one small legacy fallback surface
2. reduce it in isolation
3. run focused tests
4. run a short live soak
5. only then expand cutover

## Current Best Pause Point

This branch is in a good pause state.

It is no longer in the risky build-out phase.
It is in the controlled final phase:

- memory-quality improvement
- measured schema v2 expansion
- careful eventual cutover
