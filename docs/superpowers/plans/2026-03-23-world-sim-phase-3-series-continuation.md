# World-Sim Phase 3 Series Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a series-oriented production layer so the xianxia story simulator can continue a mainline across runs and branch child timelines from earlier runs.

**Architecture:** Build a new series orchestration layer on top of the Phase 2 run-bundle/export system. Keep simulation, bundle export, and series lineage separate: expand run snapshots so they are continuation-safe, add metadata/layout helpers for `series/<series-id>/...`, then implement a dedicated `story:series` CLI that restores prior state, continues from the latest successful run, and branches into child series.

**Tech Stack:** TypeScript, Node.js filesystem APIs, existing SQLite-backed story runtime, Vitest, execa

---

## File Structure

### New Files

- `src/story/series/layout.ts`
  - resolves `series-root`, series directory paths, run directory paths, and child branch naming
- `src/story/series/metadata.ts`
  - reads/writes `series.json`, tracks successful vs failed runs, chapter totals, and lineage
- `src/story/series/restore.ts`
  - restores canonical world state, belief state, and director state from a prior run bundle into SQLite
- `src/story/series-cli.ts`
  - high-level CLI for `continue` and `branch` workflows
- `test/story/series-metadata.test.ts`
  - focused tests for metadata shape, latest-run rules, and child-series lineage
- `test/story/series-restore.test.ts`
  - restore/rehydration tests from exported run bundles
- `test/story/series-cli.test.ts`
  - end-to-end CLI tests for root series creation, continuation, and branching

### Modified Files

- `src/story/output/serializers.ts`
  - extend run manifest metadata for series lineage fields
- `src/story/output/run-bundle.ts`
  - write `state/final-beliefs.json` and include lineage metadata in `index.json`
- `src/story/cli.ts`
  - export any small shared helpers reused by `story:series`
- `src/story/world-state.ts`
  - add targeted restore helpers for entities/relations/signals/beliefs/director state if needed
- `package.json`
  - add `story:series` script and any narrow test script if useful
- `README.md`
  - document `story:series`, continuation semantics, branching, and series layout
- `test/story/run-bundle.test.ts`
  - pin `final-beliefs.json` and expanded run manifest fields

### Existing Files To Reuse

- `src/story/runtime/run-loop.ts`
  - runtime execution surface after restore/setup
- `src/story/batch-cli.ts`
  - useful reference for explicit reset control and per-run orchestration
- `src/story/config.ts`
  - runtime config loading
- `src/store/db.ts`
  - singleton DB lifecycle used by all CLIs
- `test/helpers.ts`
  - test DB creation utilities

---

### Task 1: Add Failing Series Metadata And Layout Tests

**Files:**
- Create: `test/story/series-metadata.test.ts`

- [ ] **Step 1: Write the failing metadata tests**

```ts
it("creates a root series with nullable latestRunId and zero chapter count", () => {
  const meta = createRootSeriesMetadata({
    seriesId: "mainline-a",
    createdAt: "2026-03-23T00:00:00.000Z",
  });

  expect(meta).toMatchObject({
    schemaVersion: 1,
    seriesId: "mainline-a",
    type: "mainline",
    mode: "root",
    latestRunId: null,
    runCount: 0,
    totalChapterCount: 0,
  });
});

it("does not advance latestRunId for failed runs", () => {
  const meta = appendSeriesRun(baseMeta, {
    runId: "run-002",
    status: "failed",
    chapterCount: 2,
  });

  expect(meta.latestRunId).toBe("run-001");
  expect(meta.totalChapterCount).toBe(3);
});

it("derives readable child branch ids", () => {
  expect(deriveChildSeriesId("mainline-a", 1)).toBe("mainline-a-branch-01");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/story/series-metadata.test.ts`
Expected: FAIL because the metadata/layout modules do not exist yet.

- [ ] **Step 3: Commit the red tests**

```bash
git add test/story/series-metadata.test.ts
git commit -m "test: add series metadata coverage"
```

### Task 2: Implement Series Metadata And Layout Modules

**Files:**
- Create: `src/story/series/layout.ts`
- Create: `src/story/series/metadata.ts`
- Modify: `test/story/series-metadata.test.ts`

- [ ] **Step 1: Implement the layout helpers**

```ts
export function resolveSeriesRoot(input?: string): string {
  return path.resolve(process.cwd(), input ?? "./series");
}

export function deriveChildSeriesId(parentSeriesId: string, ordinal: number): string {
  return `${parentSeriesId}-branch-${String(ordinal).padStart(2, "0")}`;
}
```

- [ ] **Step 2: Implement the metadata model**

```ts
export interface StorySeriesRunRecord {
  runId: string;
  status: "running" | "success" | "failed";
  chapterCount: number;
  seriesChapterStart?: number;
  seriesChapterEnd?: number;
}

export interface StorySeriesMetadata {
  schemaVersion: 1;
  seriesId: string;
  type: "mainline" | "alternate";
  mode: "root" | "branch";
  latestRunId: string | null;
  runCount: number;
  totalChapterCount: number;
  runs: StorySeriesRunRecord[];
}
```

- [ ] **Step 3: Run the metadata tests**

Run: `npx vitest run test/story/series-metadata.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/story/series/layout.ts src/story/series/metadata.ts test/story/series-metadata.test.ts
git commit -m "feat: add story series metadata model"
```

### Task 3: Expand Run Bundles For Continuation Snapshots

**Files:**
- Modify: `src/story/output/serializers.ts`
- Modify: `src/story/output/run-bundle.ts`
- Modify: `test/story/run-bundle.test.ts`

- [ ] **Step 1: Write the failing snapshot/manifest assertions**

```ts
expect(existsSync(join(bundle.bundlePath, "state", "final-beliefs.json"))).toBe(true);
expect(JSON.parse(readFileSync(join(bundle.bundlePath, "index.json"), "utf8"))).toMatchObject({
  schemaVersion: 1,
  seriesId: null,
  continuedFromRunId: null,
  branchedFromRunId: null,
});
```

- [ ] **Step 2: Run the run-bundle test to verify it fails**

Run: `npx vitest run test/story/run-bundle.test.ts`
Expected: FAIL because the bundle does not yet export continuation-safe state.

- [ ] **Step 3: Implement minimal snapshot expansion**

```ts
writeFileSync(join(stateDir, "final-beliefs.json"), toPrettyJson(buildStoryBeliefSnapshot(db)), "utf8");
```

Add nullable lineage fields to the index serializer rather than inventing a second manifest.

- [ ] **Step 4: Re-run the test**

Run: `npx vitest run test/story/run-bundle.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/story/output/serializers.ts src/story/output/run-bundle.ts test/story/run-bundle.test.ts
git commit -m "feat: export continuation snapshots for series runs"
```

### Task 4: Add Failing Restore Tests

**Files:**
- Create: `test/story/series-restore.test.ts`

- [ ] **Step 1: Write the failing restore tests**

```ts
it("rehydrates canonical world, beliefs, and director state from a prior run bundle", async () => {
  const sourceDb = createTestDb();
  initializeStoryWorld(sourceDb);
  const loopResult = await runStoryLoop(sourceDb, { turns: 3, model: createStubStoryModelClient() });
  const bundle = await writeRunBundle(sourceDb, loopResult, seriesAwareMeta);

  const targetDb = createTestDb();
  await restoreSeriesRun(targetDb, { bundlePath: bundle.bundlePath });

  expect(readBeliefCount(targetDb)).toBeGreaterThan(0);
  expect(loadDirectorState(targetDb).recentPovIds.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run the restore test to verify it fails**

Run: `npx vitest run test/story/series-restore.test.ts`
Expected: FAIL because restore helpers do not exist yet.

- [ ] **Step 3: Commit the red test**

```bash
git add test/story/series-restore.test.ts
git commit -m "test: add series restore coverage"
```

### Task 5: Implement Restore Helpers

**Files:**
- Create: `src/story/series/restore.ts`
- Modify: `src/story/world-state.ts`
- Modify: `test/story/series-restore.test.ts`

- [ ] **Step 1: Add focused restore helpers in world-state**

Add small restore-oriented helpers rather than overloading initialization:

```ts
export function restoreStorySnapshot(db: DatabaseSyncInstance, snapshot: StoryRestoreSnapshot): void {
  clearStoryRuntimeState(db);
  // insert entities, relations, beliefs, director state, and narrative signals
}
```

- [ ] **Step 2: Implement bundle restore**

```ts
export async function restoreSeriesRun(
  db: DatabaseSyncInstance,
  input: { bundlePath: string },
): Promise<void> {
  const world = readJson(join(input.bundlePath, "state", "final-world.json"));
  const beliefs = readJson(join(input.bundlePath, "state", "final-beliefs.json"));
  const director = readJson(join(input.bundlePath, "state", "final-director.json"));
  restoreStorySnapshot(db, { world, beliefs, director });
}
```

- [ ] **Step 3: Re-run the restore tests**

Run: `npx vitest run test/story/series-restore.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/story/series/restore.ts src/story/world-state.ts test/story/series-restore.test.ts
git commit -m "feat: restore series state from run bundles"
```

### Task 6: Add Failing Series CLI Tests

**Files:**
- Create: `test/story/series-cli.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing CLI tests**

```ts
it("creates a root series and then continues from its latest successful run", async () => {
  const result = await execa("npm", [
    "run",
    "story:series",
    "--",
    "--series=mainline-a",
    "--turns=3",
    "--stub-model",
    `--series-root=${seriesRoot}`,
  ], { cwd: repoRoot, env: { ...process.env, NOVEL_LLM_MODE: "anthropic-compatible" } });

  expect(result.stdout).toContain("series=mainline-a");
  expect(result.stdout).toContain("mode=continue");
});

it("branches from an earlier successful run into a child series", async () => {
  const result = await execa("npm", [
    "run",
    "story:series",
    "--",
    "--series=mainline-a",
    "--mode=branch",
    "--from-run=run-id-placeholder",
    "--turns=3",
    "--stub-model",
    `--series-root=${seriesRoot}`,
  ], { cwd: repoRoot, reject: false });

  expect(result.exitCode).not.toBe(0);
});
```

- [ ] **Step 2: Add the package script placeholder**

```json
{
  "scripts": {
    "story:series": "node --import tsx src/story/series-cli.ts"
  }
}
```

- [ ] **Step 3: Run the series CLI tests to verify they fail**

Run: `npx vitest run test/story/series-cli.test.ts`
Expected: FAIL because the CLI does not exist yet.

- [ ] **Step 4: Commit**

```bash
git add package.json test/story/series-cli.test.ts
git commit -m "test: add story series cli coverage"
```

### Task 7: Implement `story:series` Continue Mode

**Files:**
- Create: `src/story/series-cli.ts`
- Modify: `src/story/cli.ts`
- Modify: `package.json`
- Modify: `test/story/series-cli.test.ts`

- [ ] **Step 1: Implement root-series creation and continue mode**

```ts
const meta = loadOrCreateSeriesMetadata(...);
const sourceRunId = meta.latestRunId;
if (sourceRunId) {
  await restoreSeriesRun(db, { bundlePath: resolveSeriesRunPath(...) });
}
const result = await runStoryLoop(db, { turns, model });
```

- [ ] **Step 2: Ensure continuation runs execute with `resetOnStart=false`**

Do not allow `loadStoryConfig()` / runtime defaults to clear restored state during `story:series`.

- [ ] **Step 3: Write successful run records**

Each successful run should update:

- `latestRunId`
- `runCount`
- `totalChapterCount`
- `seriesChapterStart`
- `seriesChapterEnd`

- [ ] **Step 4: Run the series CLI tests**

Run: `npx vitest run test/story/series-cli.test.ts`
Expected: PARTIAL PASS or FAIL only on branch cases still unimplemented

- [ ] **Step 5: Commit**

```bash
git add src/story/series-cli.ts src/story/cli.ts package.json test/story/series-cli.test.ts
git commit -m "feat: add story series continuation cli"
```

### Task 8: Implement Branch Mode And Failure Rules

**Files:**
- Modify: `src/story/series-cli.ts`
- Modify: `src/story/series/metadata.ts`
- Modify: `src/story/series/layout.ts`
- Modify: `test/story/series-cli.test.ts`

- [ ] **Step 1: Implement child-series creation**

```ts
if (mode === "branch") {
  assertFromRunPresent(fromRunId);
  const childSeriesId = deriveChildSeriesId(parentSeriesId, nextOrdinal);
  // create child metadata with parentSeriesId + branchedFromRunId
}
```

- [ ] **Step 2: Enforce CLI validation rules**

Reject:

- `branch` without `--from-run`
- `continue` with non-latest `--from-run`

- [ ] **Step 3: Preserve failed runs without advancing latestRunId**

Record failed attempts with `status: "failed"` and leave the canonical continuation pointer untouched.

- [ ] **Step 4: Re-run the series CLI tests**

Run: `npx vitest run test/story/series-cli.test.ts`
Expected: PASS

- [ ] **Step 5: Re-run adjacent regression tests**

Run: `npx vitest run test/story/run-bundle.test.ts test/story/series-restore.test.ts test/story/series-cli.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/story/series-cli.ts src/story/series/metadata.ts src/story/series/layout.ts test/story/series-cli.test.ts
git commit -m "feat: add story series branching flow"
```

### Task 9: Document Series Workflow

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the README**

Add a dedicated section covering:

- `story:series`
- `--series-root`
- default `continue`
- explicit `branch`
- `series/<series-id>/runs/<run-id>/` layout
- relationship to existing `story:run` and `story:batch`

Include examples:

```bash
npm run story:series -- --series=my-mainline --turns=6 --stub-model
npm run story:series -- --series=my-mainline --mode=branch --from-run=<run-id> --turns=6 --stub-model
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add story series workflow"
```

### Task 10: Final Verification

**Files:**
- No new files required unless verification reveals a gap

- [ ] **Step 1: Run the focused series suite**

Run: `npx vitest run test/story/run-bundle.test.ts test/story/series-metadata.test.ts test/story/series-restore.test.ts test/story/series-cli.test.ts`
Expected: PASS

- [ ] **Step 2: Run the full story suite**

Run: `npm run test:story`
Expected: PASS

- [ ] **Step 3: Run the full repository suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Run the build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 5: Verify root-series creation manually**

Run:

```bash
series_root=$(mktemp -d /tmp/story-phase3-series-XXXXXX)
npm run story:series -- --series=mainline-a --turns=3 --stub-model --series-root="$series_root"
```

Expected:

- stdout identifies `series=mainline-a`
- one run exists under `series_root/mainline-a/runs/`
- `series.json` has `latestRunId`

- [ ] **Step 6: Verify continuation manually**

Run:

```bash
npm run story:series -- --series=mainline-a --turns=3 --stub-model --series-root="$series_root"
```

Expected:

- a second run appears in the same series
- `totalChapterCount` increases
- `latestRunId` updates

- [ ] **Step 7: Verify branch creation manually**

Run:

```bash
npm run story:series -- --series=mainline-a --mode=branch --from-run="<prior-run-id>" --turns=3 --stub-model --series-root="$series_root"
```

Expected:

- a child series directory is created
- source series remains unchanged
- child `series.json` records `parentSeriesId` and `branchedFromRunId`

- [ ] **Step 8: Commit any final verification-only adjustments**

```bash
git add README.md package.json src/story/cli.ts src/story/output/serializers.ts src/story/output/run-bundle.ts src/story/series-cli.ts src/story/series/layout.ts src/story/series/metadata.ts src/story/series/restore.ts src/story/world-state.ts test/story/run-bundle.test.ts test/story/series-metadata.test.ts test/story/series-restore.test.ts test/story/series-cli.test.ts
git commit -m "chore: finalize phase 3 series continuation rollout"
```

## Verification Checklist

Before calling Phase 3 complete, verify all of the following:

- `test/story/run-bundle.test.ts` passes
- `test/story/series-metadata.test.ts` passes
- `test/story/series-restore.test.ts` passes
- `test/story/series-cli.test.ts` passes
- `npm run test:story` passes
- `npm test` passes
- `npm run build` passes
- `story:series` can create a new root series
- `story:series` can continue the latest successful run in a series
- `story:series` rejects non-latest `--from-run` in continue mode
- `story:series` can branch an earlier run into a child series
- failed runs do not advance `latestRunId`
- `final-beliefs.json` is exported and used for restore
- `totalChapterCount` advances only on successful runs
- no committed file contains real `NOVEL_LLM_API_KEY` values or hard-coded production secrets
- README is sufficient for a new engineer to create, continue, and branch a series locally
