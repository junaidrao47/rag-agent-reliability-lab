import "dotenv/config";
import { AsyncLocalStorage } from "node:async_hooks";

function flag(name) {
  const value = (process.env[name] ?? "").trim().toLowerCase();
  return value === "1" || value === "true";
}

// Failure flags. All default to false; with every flag off the agent behaves
// normally. Each flag changes behavior in exactly one place:
//   STALE_DOC   -> src/retrieval.js  (policyFilter / onePerTitle)
//   WRONG_TOOL  -> src/tools.js      (getToolDefinitions)
//   HALLUCINATE -> src/tools.js      (lookup_order handler) and
//                  src/agent.js      (buildSystemPrompt)
//   IGNORE_RULE -> src/agent.js      (buildSystemPrompt)
//   TRUNCATE    -> src/agent.js      (buildPolicyContext)
// Only one flag may be on at a time.
export const FLAG_NAMES = Object.freeze([
  "STALE_DOC",
  "WRONG_TOOL",
  "HALLUCINATE",
  "IGNORE_RULE",
  "TRUNCATE",
]);

function freezeFlags(values) {
  const result = Object.fromEntries(
    FLAG_NAMES.map((name) => [name, Boolean(values[name])]),
  );
  const active = FLAG_NAMES.filter((name) => result[name]);
  if (active.length > 1) {
    throw new Error(`Only one flag may be on at a time, got: ${active.join(", ")}`);
  }
  return Object.freeze(result);
}

// Values from the environment (.env).
export const flags = freezeFlags(
  Object.fromEntries(FLAG_NAMES.map((name) => [name, flag(name)])),
);

// Per-request override. It lives in async context only, so it never touches
// the request, the prompt or the trace.
const requestFlags = new AsyncLocalStorage();

/** The flags in effect for the current request: the override if any, else env. */
export function getFlags() {
  return requestFlags.getStore() ?? flags;
}

/**
 * Runs fn with exactly the given flags on (all others off), ignoring env.
 * withFlags({}, fn) forces every flag off.
 */
export function withFlags(values, fn) {
  return requestFlags.run(freezeFlags(values), fn);
}

export const config = Object.freeze({
  port: Number(process.env.PORT) || 3000,
  // MONGODB_URI is the documented name; MONGODB_URL is accepted as an alias.
  mongodbUri:
    process.env.MONGODB_URI ||
    process.env.MONGODB_URL ||
    "mongodb://localhost:27017/agent_failure_lab",
  groqApiKey: process.env.GROQ_API_KEY,
  groqModel: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
  embeddingModel: process.env.EMBEDDING_MODEL || "Xenova/all-MiniLM-L6-v2",
  // The trace name Lemma files this agent under. Do not rename.
  agentName: "agent-failure-lab",
});
