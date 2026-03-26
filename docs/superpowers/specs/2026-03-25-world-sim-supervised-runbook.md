# World-Sim Supervised Production / Soak Runbook

Date: 2026-03-25
Status: Executable supervised runbook (internal)
Project: graph-memory (world-sim xianxia MVP)

## Purpose

This runbook defines how to run **supervised** production-style generation and soak validation for the current branch.

It is intentionally conservative:

- It documents what is currently **ready enough** to run (under supervision).
- It documents what is **not** ready (no schema v2-only cutover, no legacy removal).
- It provides commands, stop procedures, and concrete pass/fail signals.

Source of truth: `AGENTS.md` and `World-Sim Story Memory V2 Cutover Checklist` (2026-03-24).

## Readiness Boundary (What This Runbook Covers)

Current verified state (already passed on this branch):

- full test suite passes (`npm test`)
- TypeScript build passes (`npm run build`)
- live MiniMax smoke passes
- 3-run live soak passes
- 6-run live soak passes
- continuation restore + run bundles are stable

Readiness decision:

- YES: supervised internal production runs, iterative authoring, additional soak validation.
- NO: unattended 24h cutover as the only production path.
- NO: removing legacy compatibility or switching to schema v2-only everywhere.
- NO: committing secrets / provider credentials.

## Non-Negotiables (Operational Safety)

- Do not commit `.env` files, provider API keys, tokens, or copied credential snippets into tracked files.
- Treat `.local/` and `runs/` as generated artifacts (inspect them; do not treat them as authored truth).
- Do not treat legacy `story_relations` as canonical story truth.
  - Legacy relations are known to be residue-heavy (`EXECUTES` dominates).
  - Schema v2 `projectedRelations` is the preferred canonical read surface where available.
- Keep `dual-write`.

## Quick Start (Supervised Smoke)

Goal: one small run using real provider wiring, with an isolated series root, then validate artifacts.

Important invariant:

- `--series-root` isolates run bundles and series metadata.
- a brand-new series is expected to start from a fresh seeded world at turn `1` even if `NOVEL_DB_PATH` points to a reused/shared runtime database.
- only continuation or branch runs should inherit prior state via bundle restore.

Preflight (required before claiming anything is “ready”):

```bash
npm test
npm run build
```

Run a smoke series (1 turn) into an isolated root:

```bash
npm run story:series -- \
  --series=xianxia-mainline \
  --series-root=.local/series-smoke-v2 \
  --turns=1
```

After it finishes, it prints `bundle=...` and `latestRunId=...`. Proceed to the “Post-Run Checks” section.

## Recommended Commands (Supervised Soak)

### Single-run continuation (manual pacing)

Use this when you want to examine every run output before continuing:

```bash
npm run story:series -- \
  --series=xianxia-mainline \
  --series-root=.local/series-soak \
  --turns=3
```

Repeat the same command to continue from the latest successful run.

### Long-run loop (timeboxed soak)

Use this when you want a controlled loop that stops at a deadline (still supervised):

```bash
npm run story:long-run -- \
  --series=xianxia-mainline \
  --series-root=.local/series-24h \
  --turns=3 \
  --duration-hours=24 \
  --cooldown-seconds=5 \
  --label=minimax-24h
```

Helper script (local-only; sources a local env file):

```bash
./.local/run-minimax-24h.sh \
  .local/series-24h \
  xianxia-mainline \
  3 \
  minimax-24h \
  24 \
  5
```

Note: `./.local/run-minimax-24h.sh` sources `./.local/minimax-story.env`. Keep that file local and untracked.

## Stop Procedures

### Graceful stop (recommended)

`story:long-run` checks for a stop file between runs.

If you started with default control dir:

- Control dir: `${series_root}/.long-run/${label}/`
- Stop file: `${series_root}/.long-run/${label}/STOP`

Create the stop file:

```bash
touch .local/series-24h/.long-run/minimax-24h/STOP
```

This stops the loop cleanly after the current run completes.

### Immediate stop (use only when needed)

If the process is stuck or you need to halt mid-run:

- Send `Ctrl-C` in the terminal (SIGINT).

Expected side effects:

- The current run may be recorded as failed in series metadata (`series.json`).
- Treat this as an operator-interrupted run; it is not automatically a “schema v2 failure”, but it is not a clean soak signal either.

## What To Observe (Metrics and Artifacts)

### Required artifacts per successful bundle

Each successful run bundle should contain (strict continuation contract):

- `state/final-world.json`
- `state/final-beliefs.json`
- `state/final-director.json`
- `state/consistency.json`

If any required file is missing, treat it as a **hard failure**.

### Session state (long-run controller)

For `story:long-run`, inspect:

- `summary.json` for status, completed runs, last bundle path, `failureMessage`, and `lastFailureCode`
- `events.jsonl` for a timeline (`session-started`, `run-started`, `run-succeeded`, `run-failed`, `session-stopped`)
- every `run-failed` event should carry a `failureCode`

Default location:

```text
.local/<series-root>/.long-run/<label>/
```

### Operational taxonomy

Use these controller-side classes when triaging supervised runs:

- `llm_empty_content`
  Meaning: provider returned a structurally successful response with no usable text.
  Action: recoverable iteration failure. Warn and continue unless it clusters or causes missed deadlines.
- `llm_network_error`
  Meaning: transient fetch/network failure such as `fetch failed`.
  Action: recoverable iteration failure after retries are exhausted. Warn and continue unless sustained.
- `llm_request_timeout`
  Meaning: provider request exceeded the configured timeout.
  Action: recoverable iteration failure after retries are exhausted. Warn and continue unless sustained.
- `invalid_chapter_focus_ranking`
  Meaning: model returned malformed chapter-focus ranking JSON.
  Action: no longer a failed iteration by itself; runtime should fall back to original order and log a warning.
- `invalid_faction_action_ranking`
  Meaning: model returned malformed faction-ranking JSON.
  Action: no longer a failed iteration by itself; runtime should fall back to original order and log a warning.
- `unknown`
  Meaning: local contract or orchestration failure outside the typed runtime classes.
  Action: investigate. Repeated `unknown` failures are stronger evidence of a local bug than a provider blip.

Hard-stop classes remain:

- restore failure
- post-run metadata / contract failure after `story:series` reports success
- missing required bundle artifacts
- projected `EXECUTES` leakage
- non-zero `consistency_issues`
- uncaught controller exit

Recoverable / supervised classes remain:

- `llm_empty_content`
- `llm_network_error`
- `llm_request_timeout`
- provider 5xx / 429 cases that still exhaust retries

Normalized degraded behaviors that should be visible in logs but not counted as failed iterations:

- malformed chapter-focus ranking fallback
- malformed faction-ranking fallback

### Bundle-level story memory shape (schema v2 vs legacy)

From cutover checklist (recent soak observations, 2026-03-24):

- `relations = 848`
- `projectedRelations = 1`
- `threadState = 1`
- `identities = 2`
- `executes_in_projected = 0`
- `executes_in_legacy = 740`
- `consistency_issues = 0`

Interpretation:

- Schema v2 projected memory is staying clean.
- Legacy relations remain residue-heavy.
- Stability is proven; coverage is not yet complete.

#### How to compute these numbers for the latest run

1) Locate the latest bundle path:

```bash
node --input-type=module -e '
import fs from "node:fs";
const series = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const run = series.runs.find((r) => r.runId === series.latestRunId);
console.log(run?.path ?? "");
' .local/series-24h/xianxia-mainline/series.json
```

2) Inspect memory counts in `final-world.json`:

```bash
node --input-type=module -e '
import fs from "node:fs";
const world = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const legacy = world.relations ?? [];
const projected = world.projectedRelations ?? [];
const identities = world.identities ?? [];
const thread = world.threadState ?? [];
const countExec = (arr) => arr.filter((r) => r?.relation === "EXECUTES").length;
const out = {
  relations: legacy.length,
  projectedRelations: projected.length,
  identities: identities.length,
  threadState: thread.length,
  executes_in_legacy: countExec(legacy),
  executes_in_projected: countExec(projected),
};
console.log(JSON.stringify(out, null, 2));
' /path/to/bundle/state/final-world.json
```

3) Inspect consistency issues:

```bash
node --input-type=module -e '
import fs from "node:fs";
const issues = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
console.log({ consistency_issues: Array.isArray(issues) ? issues.length : null });
' /path/to/bundle/state/consistency.json
```

### Manual quality checks (still required)

Even if metrics are clean, supervised runs must still include a human read of continuity:

- chapter continuity across multiple continuation runs (identity, relationships, thread progression)
- no obvious regression in recall usefulness or chapter packet summaries

## Failure Criteria (When You Can Call the Soak “Failed”)

Hard failures (stop and investigate):

- `npm test` fails or `npm run build` fails on the exact commit being run.
- `story:series` or `story:long-run` exits non-zero (uncaught error).
- continuation restore fails (cannot resume from last successful bundle).
- the first run of a brand-new series does not start at turn `1`, or unexpectedly behaves like a continuation (`continuedFromRunId != null`).
- required bundle files are missing (`final-world.json`, `final-beliefs.json`, `final-director.json`, `consistency.json`).
- `consistency.json` contains any issues (`consistency_issues > 0`).
- any `EXECUTES` leakage appears in schema v2 projected relations (`executes_in_projected > 0`).

Soft failures / warnings (do not immediately declare schema v2 broken, but do not proceed blindly):

- repeated `llm_empty_content`, `llm_network_error`, or `llm_request_timeout` entries in `events.jsonl`
- repeated malformed-ranking fallback warnings in runtime logs
- projected coverage is still trivially small (e.g. `projectedRelations` stays near-zero) while manual continuity expectations rise.
- chapter continuity is visibly regressing even when metrics look “clean”.
- repeated operator interrupts (Ctrl-C) prevent clean signals.

## When You Must Not Do Schema V2-only Cutover (and Why)

Do not tighten to schema v2-only reads, and do not reduce `dual-write`, unless all exit criteria are satisfied.

Per cutover checklist, do not reduce legacy dependence until:

- at least one longer soak beyond current 6-run verification still passes without restore drift
- projected relation coverage is no longer trivially tiny versus the durable facts we expect to preserve
- no critical runtime path still requires legacy `story_relations` for correctness
- snapshot restore can rebuild a valid continuation state from schema v2 exports without relying on legacy residue-heavy relations
- recall quality remains stable when legacy fallback is reduced
- chapter quality remains stable across multiple continuation runs

Practical “today” decision (2026-03-25):

- Do not fully shift to schema v2-only reads yet.
- Do keep `dual-write`.
- Do treat the branch as stable enough for additional supervised runs and memory-quality iteration.
