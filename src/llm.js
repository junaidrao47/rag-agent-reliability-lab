// All model calls go through this module, so swapping providers means
// changing only this file. Callers pass and receive OpenAI-style messages.
import OpenAI from "openai";
import { config } from "./config.js";

export const llmInfo = Object.freeze({
  provider: "groq",
  model: config.groqModel,
  params: { temperature: 0.2, max_tokens: 700 },
});

// Running totals for this process, so scripts can report what they used.
export const llmStats = { requests: 0, tokens: 0, rateLimitWaits: 0 };

let client;

function getClient() {
  if (!config.groqApiKey) {
    throw new Error("GROQ_API_KEY is not set. Add it to .env.");
  }
  if (!client) {
    client = new OpenAI({
      apiKey: config.groqApiKey,
      baseURL: "https://api.groq.com/openai/v1",
      maxRetries: 0, // retries are handled below so a 429 is retried exactly once
    });
  }
  return client;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function header(headers, name) {
  return headers?.get?.(name) ?? headers?.[name];
}

function retryDelayMs(error) {
  const seconds = Number(header(error?.headers, "retry-after"));
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds, 60) * 1000 + 500;
  }
  return 10_000;
}

/** True when a 429 is the per-day quota, which no short wait will clear. */
export function isDailyLimit(error) {
  return (
    error?.status === 429 &&
    /per day|\b(TPD|RPD)\b/i.test(String(error?.error?.message ?? error?.message ?? ""))
  );
}

// Groq durations look like "7.66s", "2m59.56s" or "120ms".
function parseDurationMs(text) {
  let ms = 0;
  for (const [, amount, unit] of String(text ?? "").matchAll(/([\d.]+)(ms|s|m|h)/g)) {
    ms += Number(amount) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit];
  }
  return ms;
}

// Per-minute token budget reported by the last response. When it is nearly
// used up, the next call waits for it to reset instead of running into a 429.
const LOW_TOKEN_BUDGET = 2500;
let tokenBudget = null; // { remaining, resetAt }

function noteTokenBudget(headers) {
  const remaining = Number(header(headers, "x-ratelimit-remaining-tokens"));
  const resetMs = parseDurationMs(header(headers, "x-ratelimit-reset-tokens"));
  tokenBudget =
    Number.isFinite(remaining) && resetMs > 0
      ? { remaining, resetAt: Date.now() + resetMs }
      : null;
}

async function waitForTokenBudget() {
  if (!tokenBudget || tokenBudget.remaining >= LOW_TOKEN_BUDGET) return;
  const waitMs = tokenBudget.resetAt - Date.now();
  tokenBudget = null;
  if (waitMs > 0) {
    llmStats.rateLimitWaits++;
    await sleep(Math.min(waitMs, 60_000) + 250);
  }
}

async function send(request) {
  llmStats.requests++;
  const { data, response } = await getClient()
    .chat.completions.create(request)
    .withResponse();
  noteTokenBudget(response.headers);
  llmStats.tokens += data.usage?.total_tokens ?? 0;
  return data;
}

/**
 * chat({ messages, tools, params? }) -> { message, usage, model, finishReason }
 * `message` is the assistant message ({ role, content, tool_calls? }).
 */
export async function chat({ messages, tools, params }) {
  const request = {
    model: llmInfo.model,
    messages,
    ...llmInfo.params,
    ...params, // optional per-call overrides; the agent passes none
    ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
  };

  await waitForTokenBudget();
  let response;
  try {
    response = await send(request);
  } catch (error) {
    if (error?.status !== 429 || isDailyLimit(error)) throw error;
    // Free tier rate limit: wait as long as the provider asks, then retry once.
    llmStats.rateLimitWaits++;
    await sleep(retryDelayMs(error));
    response = await send(request);
  }

  const choice = response.choices[0];
  const message = {
    role: "assistant",
    content: choice.message.content ?? "",
    ...(choice.message.tool_calls?.length
      ? { tool_calls: choice.message.tool_calls }
      : {}),
  };

  return {
    message,
    usage: response.usage,
    model: response.model,
    finishReason: choice.finish_reason,
  };
}
