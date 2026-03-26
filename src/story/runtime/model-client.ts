import {
  StoryRuntimeError,
  getStoryRuntimeErrorCode,
  type CompleteFn,
} from "../../engine/llm.ts";
import type { StoryRuntimeConfig } from "../config.ts";
import { createAnthropicCompatibleCompleteFn, createStoryCompleteFn } from "../../engine/llm.ts";

export type StoryAction = {
  id: string;
  type: string;
  summary?: string;
  [key: string]: unknown;
};

export interface ActorDecisionInput {
  actorId?: string;
  prompt?: string;
  scene?: string;
}

export interface FactionDecisionInput {
  factionId?: string;
  prompt?: string;
  stakes?: string[];
}

export interface ChapterSelection {
  id: string;
  focus: string;
  score: number;
}

export interface NarrativeDirectorInput {
  directorId?: string;
  activeThreads?: string[];
  notes?: string;
}

export interface ChapterPacket {
  turnNumber: number;
  focus: string;
  summary?: string;
}

export interface TurnSummaryInput {
  turnNumber: number;
  highlights: string[];
  events: string[];
}

export interface StoryClaim {
  subjectId: string;
  predicate: string;
  objectId?: string;
  valueText?: string;
  evidenceSpan: string;
}

export interface StoryModelClient {
  rerankActorActions(actions: StoryAction[], context: ActorDecisionInput): Promise<StoryAction[]>;
  rerankFactionActions(actions: StoryAction[], context: FactionDecisionInput): Promise<StoryAction[]>;
  rerankChapterFocus(
    candidates: ChapterSelection[],
    context: NarrativeDirectorInput,
  ): Promise<ChapterSelection[]>;
  generateChapter(packet: ChapterPacket): Promise<string>;
  summarizeTurn(input: TurnSummaryInput): Promise<string>;
  extractClaims(prose: string): Promise<StoryClaim[]>;
}

export function createStoryModelClient(cfg: StoryRuntimeConfig["llm"]): StoryModelClient {
  const completeFn =
    cfg.mode === "anthropic-compatible"
      ? createAnthropicCompatibleCompleteFn({
          apiKey: cfg.apiKey,
          baseURL: cfg.baseURL,
          model: cfg.model,
          timeoutMs: cfg.timeoutMs,
          maxRetries: cfg.maxRetries,
          retryBaseDelayMs: cfg.retryBaseDelayMs,
        })
      : createStoryCompleteFn({
          apiKey: cfg.apiKey,
          baseURL: cfg.baseURL,
          model: cfg.model,
          timeoutMs: cfg.timeoutMs,
          maxRetries: cfg.maxRetries,
          retryBaseDelayMs: cfg.retryBaseDelayMs,
        });

  return buildStoryModelClient(completeFn);
}

export function buildStoryModelClientForTest(completeFn: CompleteFn): StoryModelClient {
  return buildStoryModelClient(completeFn);
}

function buildStoryModelClient(completeFn: CompleteFn): StoryModelClient {
  return {
    rerankActorActions: async (actions, context) => {
      const raw = await callModel(
        completeFn,
        "Return only a JSON array of actor action ids ordered from strongest to weakest.",
        JSON.stringify({ actions, context }),
      );
      return parseRankedActions(raw, actions, "actor action");
    },
    rerankFactionActions: async (actions, context) => {
      const raw = await callModel(
        completeFn,
        "Return only a JSON array of faction action ids ordered from strongest to weakest.",
        JSON.stringify({ actions, context }),
      );
      return parseRankedActionsWithFallback(raw, actions, "faction action");
    },
    rerankChapterFocus: async (candidates, context) => {
      const raw = await callModel(
        completeFn,
        "Return only a JSON array of chapter focus ids ordered from strongest to weakest.",
        JSON.stringify({ candidates, context }),
      );
      return parseRankedSelectionsWithFallback(raw, candidates);
    },
    generateChapter: async (packet) => {
      const prompt = [
        `Generate chapter for turn ${packet.turnNumber}, focus ${packet.focus}`,
        `Chapter context summary: ${packet.summary ?? "(none)"}`,
      ].join("\n");
      const narrative = await callModel(completeFn, "generate chapter", prompt);
      if (narrative.trim()) {
        return narrative;
      }
      throw new StoryRuntimeError(
        "invalid_chapter_generation",
        "[story-runtime] Invalid chapter generation response",
      );
    },
    summarizeTurn: async (input) => {
      const summaryPrompt = `Summarize turn ${input.turnNumber} with highlights ${input.highlights.join(";")}`;
      const summary = await callModel(completeFn, "summarize turn", summaryPrompt);
      if (summary.trim()) {
        return summary;
      }
      throw new StoryRuntimeError(
        "invalid_turn_summary",
        "[story-runtime] Invalid turn summary response",
      );
    },
    extractClaims: async (prose) => {
      const raw = await callModel(
        completeFn,
        "Return only a JSON array of story claims with subjectId, predicate, optional objectId, optional valueText, and evidenceSpan.",
        prose,
      );
      return parseClaims(raw);
    },
  };
}

async function callModel(completeFn: CompleteFn, operation: string, user: string) {
  try {
    return await completeFn(operation, user);
  } catch (err) {
    if (err instanceof Error) {
      throw err;
    }
    throw new Error(`[story-runtime] Failed to ${operation}`);
  }
}

function parseRankedActions(raw: string, actions: StoryAction[], label: "actor action" | "faction action") {
  const ids = parseJsonArrayOfStrings(raw, `Invalid ${label} ranking response`);
  const byId = new Map(actions.map((action) => [action.id, action]));

  const ranked = ids.map((id) => {
    const action = byId.get(id);
    if (!action) {
      throw new Error(`[story-runtime] Invalid ${label} ranking response`);
    }
    return action;
  });

  if (ranked.length !== actions.length || new Set(ids).size !== actions.length) {
    throw new Error(`[story-runtime] Invalid ${label} ranking response`);
  }

  return ranked;
}

function parseRankedActionsWithFallback(
  raw: string,
  actions: StoryAction[],
  label: "faction action",
) {
  let ids: string[];
  try {
    ids = parseJsonArrayOfStrings(raw, `Invalid ${label} ranking response`);
  } catch (error) {
    if (getStoryRuntimeErrorCode(error) !== "invalid_faction_action_ranking") {
      throw error;
    }
    console.warn(`[story-runtime] Falling back to original ${label} order after malformed model response`);
    return actions;
  }
  return rankActionsFromIds(ids, actions, label);
}

function parseRankedSelections(raw: string, candidates: ChapterSelection[]) {
  const ids = parseJsonArrayOfStrings(raw, "Invalid chapter focus ranking response");
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const ranked = ids.map((id) => {
    const candidate = byId.get(id);
    if (!candidate) {
      throw new Error("[story-runtime] Invalid chapter focus ranking response");
    }
    return candidate;
  });

  if (ranked.length !== candidates.length || new Set(ids).size !== candidates.length) {
    throw new Error("[story-runtime] Invalid chapter focus ranking response");
  }

  return ranked;
}

function parseRankedSelectionsWithFallback(raw: string, candidates: ChapterSelection[]) {
  let ids: string[];
  try {
    ids = parseJsonArrayOfStrings(raw, "Invalid chapter focus ranking response");
  } catch (error) {
    if (getStoryRuntimeErrorCode(error) !== "invalid_chapter_focus_ranking") {
      throw error;
    }
    console.warn("[story-runtime] Falling back to original chapter focus order after malformed model response");
    return candidates;
  }
  return rankSelectionsFromIds(ids, candidates);
}

function rankActionsFromIds(
  ids: string[],
  actions: StoryAction[],
  label: "actor action" | "faction action",
) {
  const byId = new Map(actions.map((action) => [action.id, action]));
  const ranked = ids.map((id) => {
    const action = byId.get(id);
    if (!action) {
      throw new StoryRuntimeError(
        label === "actor action" ? "invalid_actor_action_ranking" : "invalid_faction_action_ranking",
        `[story-runtime] Invalid ${label} ranking response`,
      );
    }
    return action;
  });

  if (ranked.length !== actions.length || new Set(ids).size !== actions.length) {
    throw new StoryRuntimeError(
      label === "actor action" ? "invalid_actor_action_ranking" : "invalid_faction_action_ranking",
      `[story-runtime] Invalid ${label} ranking response`,
    );
  }

  return ranked;
}

function rankSelectionsFromIds(ids: string[], candidates: ChapterSelection[]) {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const ranked = ids.map((id) => {
    const candidate = byId.get(id);
    if (!candidate) {
      throw new StoryRuntimeError(
        "invalid_chapter_focus_ranking",
        "[story-runtime] Invalid chapter focus ranking response",
      );
    }
    return candidate;
  });

  if (ranked.length !== candidates.length || new Set(ids).size !== candidates.length) {
    throw new StoryRuntimeError(
      "invalid_chapter_focus_ranking",
      "[story-runtime] Invalid chapter focus ranking response",
    );
  }

  return ranked;
}

function parseClaims(raw: string): StoryClaim[] {
  const parsed = parseJsonValue(raw, "Invalid story claims response");
  if (!Array.isArray(parsed)) {
    throw new StoryRuntimeError(
      "invalid_story_claims",
      "[story-runtime] Invalid story claims response",
    );
  }

  return parsed.map((claim) => {
    if (
      typeof claim?.subjectId !== "string" ||
      typeof claim?.predicate !== "string" ||
      typeof claim?.evidenceSpan !== "string"
    ) {
      throw new StoryRuntimeError(
        "invalid_story_claims",
        "[story-runtime] Invalid story claims response",
      );
    }

    return {
      subjectId: claim.subjectId,
      predicate: claim.predicate,
      objectId: typeof claim.objectId === "string" ? claim.objectId : undefined,
      valueText: typeof claim.valueText === "string" ? claim.valueText : undefined,
      evidenceSpan: claim.evidenceSpan,
    };
  });
}

function parseJsonArrayOfStrings(raw: string, message: string) {
  const parsed = parseJsonValue(raw, message);
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw storyRuntimeErrorFromMessage(message);
  }
  return parsed;
}

function parseJsonValue(raw: string, message: string) {
  const trimmed = raw.trim();
  const normalized = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;

  try {
    return JSON.parse(normalized);
  } catch {
    throw storyRuntimeErrorFromMessage(message);
  }
}

function storyRuntimeErrorFromMessage(message: string): StoryRuntimeError {
  if (message === "Invalid actor action ranking response") {
    return new StoryRuntimeError("invalid_actor_action_ranking", `[story-runtime] ${message}`);
  }
  if (message === "Invalid faction action ranking response") {
    return new StoryRuntimeError("invalid_faction_action_ranking", `[story-runtime] ${message}`);
  }
  if (message === "Invalid chapter focus ranking response") {
    return new StoryRuntimeError("invalid_chapter_focus_ranking", `[story-runtime] ${message}`);
  }
  if (message === "Invalid story claims response") {
    return new StoryRuntimeError("invalid_story_claims", `[story-runtime] ${message}`);
  }
  return new StoryRuntimeError("llm_invalid_content", `[story-runtime] ${message}`);
}
