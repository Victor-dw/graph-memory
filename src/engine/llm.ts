/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

/**
 * LLM 调用
 *
 * 路径 A：pluginConfig.llm 配置直接调 OpenAI 兼容 API
 * 路径 B：直接调 Anthropic REST API（需 ANTHROPIC_API_KEY）
 */

export interface LlmConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

export type CompleteFn = (system: string, user: string) => Promise<string>;

export interface StoryCompleteOptions {
  baseURL: string;
  model: string;
  apiKey: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

export type StoryRuntimeErrorCode =
  | "llm_empty_content"
  | "llm_invalid_json"
  | "llm_invalid_content"
  | "llm_http_error"
  | "llm_network_error"
  | "llm_request_timeout"
  | "invalid_actor_action_ranking"
  | "invalid_faction_action_ranking"
  | "invalid_chapter_focus_ranking"
  | "invalid_story_claims"
  | "invalid_chapter_generation"
  | "invalid_turn_summary";

export class StoryRuntimeError extends Error {
  code: StoryRuntimeErrorCode;

  constructor(code: StoryRuntimeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StoryRuntimeError";
    this.code = code;
  }
}

export function createStoryCompleteFn(
  options: StoryCompleteOptions,
): CompleteFn {
  const baseURL = requireStoryCompleteOption(options.baseURL, "NOVEL_LLM_BASE_URL");
  const apiKey = requireStoryCompleteOption(options.apiKey, "NOVEL_LLM_API_KEY");
  const model = requireStoryCompleteOption(options.model, "NOVEL_LLM_MODEL");

  return async (system, user) => {
    const res = await fetchWithStoryPolicy(`${baseURL.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          ...(system.trim() ? [{ role: "system", content: system.trim() }] : []),
          { role: "user", content: user },
        ],
        temperature: 0.1,
      }),
    }, "OpenAI-compatible", options);
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`[story-runtime] OpenAI-compatible LLM API ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await readStoryJsonResponse(res, "OpenAI-compatible");
    const text = data.choices?.[0]?.message?.content;
    if (typeof text === "string" && text.trim()) {
      return text;
    }
    throw new StoryRuntimeError(
      "llm_empty_content",
      "[story-runtime] OpenAI-compatible LLM returned empty content",
    );
  };
}

export function createAnthropicCompatibleCompleteFn(
  options: StoryCompleteOptions,
): CompleteFn {
  const baseURL = requireStoryCompleteOption(options.baseURL, "NOVEL_LLM_BASE_URL").replace(/\/+$/, "");
  const apiKey = requireStoryCompleteOption(options.apiKey, "NOVEL_LLM_API_KEY");
  const model = requireStoryCompleteOption(options.model, "NOVEL_LLM_MODEL");

  return async (system, user) => {
    const res = await fetchWithStoryPolicy(`${baseURL}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system,
        messages: [{ role: "user", content: user }],
      }),
    }, "Anthropic-compatible", options);
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(
        `[story-runtime] Anthropic-compatible LLM API ${res.status}: ${errText.slice(0, 200)}`,
      );
    }
    const data = await readStoryJsonResponse(res, "Anthropic-compatible");
    const text = extractAnthropicText(data);
    if (text.trim()) {
      return text;
    }
    throw new StoryRuntimeError(
      "llm_empty_content",
      "[story-runtime] Anthropic-compatible LLM returned empty content",
    );
  };
}

export function createCompleteFn(
  provider: string,
  model: string,
  llmConfig?: LlmConfig,
): CompleteFn {
  return async (system, user) => {
    // ── 路径 A（优先）：pluginConfig.llm 直接调 OpenAI 兼容 API ──
    if (llmConfig?.apiKey && llmConfig?.baseURL) {
      const baseURL = llmConfig.baseURL.replace(/\/+$/, "");
      const llmModel = llmConfig.model ?? model;
      const res = await fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${llmConfig.apiKey}`,
        },
        body: JSON.stringify({
          model: llmModel,
          messages: [
            ...(system.trim() ? [{ role: "system", content: system.trim() }] : []),
            { role: "user", content: user },
          ],
          temperature: 0.1,
        }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`[graph-memory] LLM API ${res.status}: ${errText.slice(0, 200)}`);
      }
      const data = await res.json() as any;
      const text = data.choices?.[0]?.message?.content ?? "";
      if (text) return text;
      throw new Error("[graph-memory] LLM returned empty content");
    }

    // ── 路径 B：Anthropic API ──────────────────────────────
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error(
        "[graph-memory] No LLM available. 在 openclaw.json 的 graph-memory config 中配置 llm.apiKey + llm.baseURL",
      );
    }
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 4096, system, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) throw new Error(`[graph-memory] Anthropic API ${res.status}`);
    return extractAnthropicText(await res.json() as any);
  };
}

function requireStoryCompleteOption(value: string, envName: string) {
  const trimmed = value.trim();
  if (trimmed) {
    return trimmed;
  }
  throw new Error(`[story-runtime] ${envName} is required for the story runtime`);
}

async function fetchWithStoryTimeout(
  input: string,
  init: RequestInit,
  providerLabel: string,
  timeoutMs = 180_000,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new StoryRuntimeError(
        "llm_request_timeout",
        `[story-runtime] ${providerLabel} LLM request timed out after ${timeoutMs}ms`,
      );
    }
    if (isNetworkStoryRequestError(error)) {
      throw new StoryRuntimeError(
        "llm_network_error",
        `[story-runtime] ${providerLabel} LLM request failed: ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithStoryPolicy(
  input: string,
  init: RequestInit,
  providerLabel: string,
  options: Pick<StoryCompleteOptions, "timeoutMs" | "maxRetries" | "retryBaseDelayMs">,
): Promise<Response> {
  const maxRetries = options.maxRetries ?? 2;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? 1_000;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const res = await fetchWithStoryTimeout(input, init, providerLabel, options.timeoutMs);
      if (!shouldRetryStoryStatus(res.status) || attempt === maxRetries) {
        return res;
      }
      logStoryRetry(providerLabel, attempt, maxRetries, retryDelayMs(retryBaseDelayMs, attempt), `HTTP ${res.status}`);
    } catch (error) {
      if (!isRetryableStoryRequestError(error) || attempt === maxRetries) {
        throw error;
      }
      logStoryRetry(providerLabel, attempt, maxRetries, retryDelayMs(retryBaseDelayMs, attempt), toStoryRetryReason(error));
    }

    await sleep(retryDelayMs(retryBaseDelayMs, attempt));
  }

  throw new Error(`[story-runtime] ${providerLabel} LLM request exhausted retries`);
}

async function readStoryJsonResponse(res: Response, providerLabel: string) {
  try {
    return await res.json() as any;
  } catch {
    throw new StoryRuntimeError(
      "llm_invalid_json",
      `[story-runtime] ${providerLabel} LLM returned invalid JSON`,
    );
  }
}

function extractAnthropicText(data: any): string {
  if (!Array.isArray(data.content)) {
    throw new StoryRuntimeError(
      "llm_invalid_content",
      "[story-runtime] Anthropic-compatible LLM returned invalid content",
    );
  }

  const text = data.content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n")
    .trim();

  if (text) {
    return text;
  }

  throw new StoryRuntimeError(
    "llm_empty_content",
    "[story-runtime] Anthropic-compatible LLM returned empty content",
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRetryableStoryRequestError(error: unknown): boolean {
  return isStoryRuntimeErrorCode(error, "llm_request_timeout", "llm_network_error");
}

function shouldRetryStoryStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryDelayMs(baseDelayMs: number, attempt: number): number {
  if (baseDelayMs <= 0) {
    return 0;
  }
  return baseDelayMs * (2 ** attempt);
}

function isNetworkStoryRequestError(error: unknown): error is Error {
  return error instanceof Error
    && /(fetch failed|network|socket|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT)/i.test(error.message);
}

function logStoryRetry(
  providerLabel: string,
  attempt: number,
  maxRetries: number,
  delayMs: number,
  reason: string,
): void {
  console.warn(
    `[story-runtime] ${providerLabel} retry ${attempt + 1}/${maxRetries + 1} in ${delayMs}ms after ${reason}`,
  );
}

function toStoryRetryReason(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isStoryRuntimeErrorCode(
  error: unknown,
  ...codes: StoryRuntimeErrorCode[]
): error is StoryRuntimeError {
  return error instanceof StoryRuntimeError && codes.includes(error.code);
}

export function getStoryRuntimeErrorCode(error: unknown): StoryRuntimeErrorCode | "unknown" {
  if (error instanceof StoryRuntimeError) {
    return error.code;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("returned empty content")) return "llm_empty_content";
  if (message.includes("returned invalid JSON")) return "llm_invalid_json";
  if (message.includes("returned invalid content")) return "llm_invalid_content";
  if (message.includes("timed out")) return "llm_request_timeout";
  if (message.includes("fetch failed")) return "llm_network_error";
  if (message.includes("Invalid actor action ranking response")) return "invalid_actor_action_ranking";
  if (message.includes("Invalid faction action ranking response")) return "invalid_faction_action_ranking";
  if (message.includes("Invalid chapter focus ranking response")) return "invalid_chapter_focus_ranking";
  if (message.includes("Invalid story claims response")) return "invalid_story_claims";
  if (message.includes("Invalid chapter generation response")) return "invalid_chapter_generation";
  if (message.includes("Invalid turn summary response")) return "invalid_turn_summary";
  if (message.includes("LLM API")) return "llm_http_error";
  return "unknown";
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}
