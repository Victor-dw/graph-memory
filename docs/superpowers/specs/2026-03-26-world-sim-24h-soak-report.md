# World-Sim 24h Soak Report

Date: 2026-03-26
Status: Completed
Project: graph-memory (world-sim xianxia MVP)
Series: `xianxia-mainline`
Run label: `minimax-24h-20260325-172939`

## Summary

This 24-hour supervised soak finished at the deadline and did not terminate on an uncaught runtime crash.

Outcome:

- session completed normally at deadline
- successful continuation runs: `482`
- failed iterations recovered in-loop: `15`
- total run records in `series.json`: `497`
- total chapters produced: `482`

Operational conclusion:

- the current branch is now validated for long supervised production-style generation
- the long-run controller no longer has the earlier fatal weakness where one failed iteration aborts the whole session
- the dominant remaining instability is provider / model-response quality, not continuation-loop survival

## Source Artifacts

Primary runtime artifacts for this soak:

- control summary: `.local/series-24h-supervised-20260325-172939/.long-run/minimax-24h-20260325-172939/summary.json`
- controller event log: `.local/series-24h-supervised-20260325-172939/.long-run/minimax-24h-20260325-172939/events.jsonl`
- runtime log: `.local/logs/minimax-24h-20260325-172939.log`
- series metadata: `.local/series-24h-supervised-20260325-172939/xianxia-mainline/series.json`
- latest successful bundle:
  `.local/series-24h-supervised-20260325-172939/xianxia-mainline/runs/story-2026-03-26T09-30-01-263Z-a9837ac9`

## Session Facts

From `summary.json` and `events.jsonl`:

- started at: `2026-03-25T09:30:42.249Z`
- deadline: `2026-03-26T09:30:42.249Z`
- controller finished at: `2026-03-26T09:33:48.592Z`
- final status: `completed`
- completion reason: `deadline`
- last successful run id: `story-2026-03-26T09-30-01-263Z-a9837ac9`
- last recorded failure message:
  `[story-runtime] Anthropic-compatible LLM returned empty content`

Derived ratios:

- success rate by recorded run attempts: `482 / 497 = 96.98%`
- failure rate by recorded run attempts: `15 / 497 = 3.02%`

Important operational nuance:

- the session did not stop on the last failure
- after the final recorded failure, the controller recovered and completed `2` additional successful runs before the deadline

This is the main behavioral proof that the long-run failure-recovery fix materially worked in a real soak.

## Failure Breakdown

Recovered iteration failures seen in `events.jsonl`:

- `[story-runtime] Anthropic-compatible LLM returned empty content` -> `7`
- `[story-runtime] Invalid chapter focus ranking response` -> `5`
- `fetch failed` -> `2`
- `[story-runtime] Invalid faction action ranking response` -> `1`

Interpretation:

- failures are now mostly model/provider-response quality problems
- controller resilience was good enough to absorb them without collapsing the entire session
- the highest-value next hardening work is stricter model-output validation / repair and provider fallback strategy, not loop survivability

## Memory / Snapshot Health

Latest successful bundle state files exist:

- `state/final-world.json`
- `state/final-beliefs.json`
- `state/final-director.json`
- `state/consistency.json`

Latest bundle metrics:

- `relations = 17`
- `projectedRelations = 3`
- `threadState = 1`
- `identities = 4`
- `executes_in_projected = 0`
- `consistency_issues = 0`

Interpretation:

- strict continuation snapshot contract held on the final successful run
- projected schema v2 memory remained clean
- no `EXECUTES` leaked into projected canonical memory
- no consistency violations were recorded in the final bundle

## Series Metadata Health

From `series.json`:

- `runCount = 497`
- `totalChapterCount = 482`
- `latestRunStatus = success`
- `latestRunId` matches controller summary

Interpretation:

- successful runs continued to advance chapter count correctly
- failed iterations were recorded without corrupting latest-success semantics
- continuation lineage remained intact through the full soak

## What This Soak Proves

This run is strong evidence for all of the following:

- fresh-series isolation and continuation restore remained stable over hundreds of iterations
- required bundle snapshots remained usable for ongoing continuation
- the controller can survive transient iteration failure and keep producing output
- schema v2 projected memory stayed cleaner than legacy relation surfaces during long execution
- the current branch is suitable for supervised internal production use

## What This Soak Does Not Yet Prove

This run does not justify these stronger claims yet:

- unattended, no-human-in-the-loop production as the only path
- provider-agnostic robustness
- fully trustworthy model structured-output discipline under all conditions
- safe removal of legacy compatibility or `dual-write`
- readiness to treat low projected coverage as a solved problem

## Production Readiness Decision

Current recommendation:

- `YES` for supervised production use
- `YES` for long-running internal generation jobs with monitoring
- `YES` for using this branch as the working xianxia auto-novel runtime base
- `NO` for fully unattended production cutover
- `NO` for removing fallback compatibility layers

Reasoning:

- loop survivability is now materially proven
- snapshot / restore integrity held
- memory consistency stayed clean
- but `15` recovered failures in one 24-hour soak is still too high to call the provider path fully hands-off

## Recommended Next Steps

Priority order:

1. Add defensive handling for empty-content and malformed ranking responses before they surface as failed iterations.
2. Add richer failure classification in long-run summary output so provider faults and model-format faults are easier to separate operationally.
3. Add a second 24-hour supervised soak after response-hardening to confirm the recovered-failure rate drops materially.
4. Keep `dual-write` and keep schema v2 as the preferred read surface; do not cut over legacy compatibility yet.
5. Add a small acceptance script that validates the latest bundle's required state files and core metrics after every long soak.

## Final Assessment

This 24-hour soak is a meaningful milestone.

The branch crossed from "promising but not yet trusted for long runs" into "credible supervised production runtime."

The system's main weakness has shifted:

- before this soak, the question was whether long-run continuation would stay alive
- after this soak, the bigger question is how much further provider/model-response failures can be reduced

That is a much better class of problem to have.
