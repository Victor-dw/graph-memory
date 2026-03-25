import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readBundleMetrics } from "../../src/story/output/bundle-metrics.ts";

describe("story bundle metrics", () => {
  it("extracts relation/thread/identity counts and consistency issue count from bundle state files", () => {
    const bundlePath = mkdtempSync(path.join(os.tmpdir(), "story-bundle-metrics-"));
    const stateDir = path.join(bundlePath, "state");

    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(path.join(stateDir, "final-world.json"), JSON.stringify({
        relations: [
          { id: "r-1", relation: "ALLY_OF" },
          { id: "r-2", relation: "EXECUTES" },
        ],
        projectedRelations: [
          { id: "pr-1", relation: "EXECUTES" },
          { id: "pr-2", relation: "IN_CONFLICT" },
          { id: "pr-3", relation: "OWNS" },
        ],
        threadState: [
          { threadId: "t-1" },
          { threadId: "t-2" },
          { threadId: "t-3" },
        ],
        identities: [
          { id: "i-1" },
          { id: "i-2" },
        ],
      }, null, 2), "utf8");
      writeFileSync(path.join(stateDir, "consistency.json"), JSON.stringify([
        { subjectId: "a", predicate: "ALLY_OF", objectId: "b", evidenceSpan: "foo" },
        { subjectId: "a", predicate: "ENEMY_OF", objectId: "c", evidenceSpan: "bar" },
      ], null, 2), "utf8");

      expect(readBundleMetrics(bundlePath)).toEqual({
        metricsUnavailable: false,
        bundleMetrics: {
          relations: 2,
          projectedRelations: 3,
          threadState: 3,
          identities: 2,
          executes_in_projected: 1,
          executes_in_legacy: 1,
          consistency_issues: 2,
        },
      });
    } finally {
      rmSync(bundlePath, { recursive: true, force: true });
    }
  });

  it("does not throw when bundle state files are missing", () => {
    const bundlePath = mkdtempSync(path.join(os.tmpdir(), "story-bundle-metrics-"));

    try {
      expect(readBundleMetrics(bundlePath)).toEqual({
        metricsUnavailable: true,
        warning: expect.stringContaining("final-world.json"),
      });
    } finally {
      rmSync(bundlePath, { recursive: true, force: true });
    }
  });

  it("does not throw when bundle state files contain invalid json", () => {
    const bundlePath = mkdtempSync(path.join(os.tmpdir(), "story-bundle-metrics-"));
    const stateDir = path.join(bundlePath, "state");

    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(path.join(stateDir, "final-world.json"), "{invalid", "utf8");
      writeFileSync(path.join(stateDir, "consistency.json"), "[]", "utf8");

      expect(readBundleMetrics(bundlePath)).toEqual({
        metricsUnavailable: true,
        warning: expect.stringContaining("final-world.json"),
      });
    } finally {
      rmSync(bundlePath, { recursive: true, force: true });
    }
  });
});
