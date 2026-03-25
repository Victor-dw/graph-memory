import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface StoryRunBundleMetrics {
  relations: number;
  projectedRelations: number;
  threadState: number;
  identities: number;
  executes_in_projected: number;
  executes_in_legacy: number;
  consistency_issues: number;
}

export type StoryRunBundleMetricsResult =
  | {
    metricsUnavailable: false;
    bundleMetrics: StoryRunBundleMetrics;
  }
  | {
    metricsUnavailable: true;
    warning: string;
  };

export function readBundleMetrics(bundlePath: string): StoryRunBundleMetricsResult {
  const worldPath = path.join(bundlePath, "state", "final-world.json");
  const consistencyPath = path.join(bundlePath, "state", "consistency.json");

  try {
    const world = readRequiredJsonFile(worldPath);
    const consistency = readRequiredJsonFile(consistencyPath);

    if (!isRecord(world)) {
      throw new Error(`[story-long-run] invalid bundle metrics world snapshot: ${worldPath}`);
    }
    if (!Array.isArray(consistency)) {
      throw new Error(`[story-long-run] invalid bundle metrics consistency snapshot: ${consistencyPath}`);
    }

    const relations = toArray(world.relations);
    const projectedRelations = toArray(world.projectedRelations);

    return {
      metricsUnavailable: false,
      bundleMetrics: {
        relations: relations.length,
        projectedRelations: projectedRelations.length,
        threadState: toArray(world.threadState).length,
        identities: toArray(world.identities).length,
        executes_in_projected: countExecutes(projectedRelations),
        executes_in_legacy: countExecutes(relations),
        consistency_issues: consistency.length,
      },
    };
  } catch (error) {
    return {
      metricsUnavailable: true,
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}

function readRequiredJsonFile(filePath: string): unknown {
  if (!existsSync(filePath)) {
    throw new Error(`[story-long-run] missing bundle metrics file: ${filePath}`);
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`[story-long-run] invalid bundle metrics json: ${filePath}`, { cause: error });
  }
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function countExecutes(relations: unknown[]): number {
  return relations.filter((relation) => isRecord(relation) && relation.relation === "EXECUTES").length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
