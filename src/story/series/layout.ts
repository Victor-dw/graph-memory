import path from "node:path";

export function resolveSeriesRoot(input?: string): string {
  return path.resolve(process.cwd(), input ?? "./series");
}

export function resolveSeriesPath(seriesRoot: string, seriesId: string): string {
  return path.join(seriesRoot, assertSafePathSegment(seriesId));
}

export function resolveSeriesRunsPath(seriesRoot: string, seriesId: string): string {
  return path.join(resolveSeriesPath(seriesRoot, seriesId), "runs");
}

export function resolveSeriesRunPath(seriesRoot: string, seriesId: string, runId: string): string {
  return path.join(resolveSeriesRunsPath(seriesRoot, seriesId), assertSafePathSegment(runId));
}

export function resolveSeriesMetadataPath(seriesRoot: string, seriesId: string): string {
  return path.join(resolveSeriesPath(seriesRoot, seriesId), "series.json");
}

export function deriveChildSeriesId(parentSeriesId: string, ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal <= 0) {
    throw new Error("[story-series] branch ordinal must be a positive integer");
  }
  return `${parentSeriesId}-branch-${String(ordinal).padStart(2, "0")}`;
}

export function assertSafePathSegment(value: string): string {
  const trimmed = value.trim();
  if (
    !trimmed
    || trimmed === "."
    || trimmed === ".."
    || path.isAbsolute(trimmed)
    || trimmed !== path.basename(trimmed)
    || trimmed.includes(path.sep)
    || trimmed.includes("/")
    || trimmed.includes("\\")
  ) {
    throw new Error("[story-series] invalid path segment");
  }
  return trimmed;
}
