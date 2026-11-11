// Runs the experiment questions against the agent (in-process) and appends
// one JSON line per run to results/runs.jsonl.
//
//   node scripts/run-experiment.js --condition <name|baseline|all> [--limit <n>]
//
// The condition is applied through a per-request override that exists only in
// this process. The only thing a trace carries is a random run ID (as
// request.id), which is also written to runs.jsonl. Resumable: questions that
// already have a line in runs.jsonl are skipped.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FLAG_NAMES, withFlags } from "../src/config.js";
import { runAgent } from "../src/agent.js";
import { closeDb } from "../src/db.js";
import { isDailyLimit, llmStats } from "../src/llm.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const QUESTIONS_FILE = path.join(ROOT, "data", "questions.json");
const RESULTS_DIR = path.join(ROOT, "results");
const RUNS_FILE = path.join(RESULTS_DIR, "runs.jsonl");

const CONDITIONS = [...FLAG_NAMES, "baseline"];
// Groq free tier: about 2.5 seconds between questions.
const DELAY_MS = Number(process.env.EXPERIMENT_DELAY_MS) || 2500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = { condition: undefined, limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--condition") args.condition = argv[++i];
    else if (argv[i] === "--limit") args.limit = Number(argv[++i]);
  }
  const wanted = (args.condition ?? "").toLowerCase();
  const match = wanted === "all" ? "all" : CONDITIONS.find((c) => c.toLowerCase() === wanted);
  if (!match || !(args.limit > 0)) {
    console.error(
      `Usage: node scripts/run-experiment.js --condition <${CONDITIONS.join("|")}|all> [--limit <n>]`,
    );
    process.exit(2);
  }
  return { conditions: match === "all" ? CONDITIONS : [match], limit: args.limit };
}

// --- Local keyword checks ----------------------------------------------------
// These fill the failureTriggered field in runs.jsonl. They are rough and are
// kept only for compatibility; no summary uses them. scripts/judge.js writes
// the real labels to results/labels.jsonl.

const NOT_FOUND =
  /not found|n['’o]t (been able to )?(find|locate)|unable to (find|locate)|no (order|record|match)|does(n['’]t| not) (exist|appear|match)|check (the|your) order (id|number)|double[- ]check/i;
const STATES_STATUS =
  /processing|being (processed|prepared)|shipped|delivered|cancell?ed|on its way|in transit/i;
const REFUND_DENIED =
  /(not|n['’]t|no longer) (be )?eligible|ineligible|outside (of )?(the|our)|past (the|our)|beyond (the|our)|after the 30|more than 30 days|within 30 days|window (has )?(passed|closed|expired|ended)|unfortunately|unable to|can(['’]t|not| not) (offer|issue|approve|process|provide|refund|grant)/i;
const REFUND_GRANTED =
  /\b(i|we)(['’]ve| have) (approved|processed|issued|started|initiated|submitted)|\b(i|we)(['’]ll| will) (approve|process|issue|start|initiate|submit|refund|go ahead|make an exception)|(happy|glad) to (approve|process|issue|refund|make an exception|help you get)|refund (has been|is|was) (approved|processed|issued|initiated)|make an exception|as a (one[- ]time )?(courtesy|exception|goodwill)/i;

const checks = {
  // The answer quotes the outdated 60-day window.
  mentions_60_days: ({ answer }) => /\b60\b|sixty/i.test(answer),
  // An order question was answered without looking the order up.
  no_tool_call: ({ toolCalls }) => toolCalls.length === 0,
  // A non-existent order was given a status instead of "not found".
  status_for_missing_order: ({ answer }) =>
    !NOT_FOUND.test(answer) && STATES_STATUS.test(answer),
  // An out-of-window refund was granted, or at least not declined.
  refund_not_denied: ({ answer }) => REFUND_GRANTED.test(answer) || !REFUND_DENIED.test(answer),
  // The answer lacks a detail a complete answer must contain.
  missing_details: ({ answer }, question) =>
    (question.mustMention ?? []).some((pattern) => !new RegExp(pattern, "i").test(answer)),
};

// --- Files -------------------------------------------------------------------

function loadQuestions() {
  const questions = JSON.parse(fs.readFileSync(QUESTIONS_FILE, "utf8"));
  for (const q of questions) {
    if (!CONDITIONS.includes(q.condition)) throw new Error(`${q.id}: unknown condition ${q.condition}`);
    if (!checks[q.check]) throw new Error(`${q.id}: unknown check ${q.check}`);
  }
  return questions;
}

function loadRuns() {
  if (!fs.existsSync(RUNS_FILE)) return [];
  return fs
    .readFileSync(RUNS_FILE, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function printTable(rows) {
  const headers = ["condition", "this run", "in runs.jsonl"];
  const body = rows.map((r) => [r.condition, String(r.run), String(r.total)]);
  const widths = headers.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join("  ");
  console.log(line(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of body) console.log(line(row));
}

// --- Main --------------------------------------------------------------------

const { conditions, limit } = parseArgs(process.argv.slice(2));
const questions = loadQuestions();
fs.mkdirSync(RESULTS_DIR, { recursive: true });
const done = new Set(loadRuns().map((run) => run.questionId));

const queue = conditions.flatMap((condition) =>
  questions.filter((q) => q.condition === condition).slice(0, limit),
);
const pending = queue.filter((q) => !done.has(q.id));
console.log(
  `${queue.length} questions selected, ${queue.length - pending.length} already in results/runs.jsonl, ${pending.length} to run.`,
);

const thisRun = new Map(CONDITIONS.map((c) => [c, { condition: c, run: 0, total: 0 }]));
let stopReason = null;

for (const [index, q] of pending.entries()) {
  const runId = randomUUID();
  const overrides = q.condition === "baseline" ? {} : { [q.condition]: true };
  process.stdout.write(`[${index + 1}/${pending.length}] ${q.condition} ${q.id} ... `);

  let result;
  try {
    // runAgent resolves only after its trace has been delivered to Lemma.
    result = await withFlags(overrides, () => runAgent(q.question, { requestId: runId }));
  } catch (error) {
    console.log("stopped");
    stopReason = isDailyLimit(error)
      ? `Groq daily limit reached: ${error.message}\nNothing was written for ${q.id}. Run the same command again after the limit resets; finished questions are skipped.`
      : `Run failed on ${q.id}: ${error.message}\nNothing was written for it. Fix the cause and run the same command again; finished questions are skipped.`;
    stopReason += `\nThe interrupted request sent a trace with an error span (request.id ${runId}); it has no line in runs.jsonl.`;
    break;
  }

  const failureTriggered = Boolean(checks[q.check](result, q));
  const record = {
    runId,
    timestamp: new Date().toISOString(),
    condition: q.condition,
    questionId: q.id,
    question: q.question,
    answer: result.answer,
    sources: result.sources,
    toolCalls: result.toolCalls,
    failureTriggered,
  };
  fs.appendFileSync(RUNS_FILE, JSON.stringify(record) + "\n");

  thisRun.get(q.condition).run++;
  console.log("done");

  if (index < pending.length - 1) await sleep(DELAY_MS);
}

await closeDb();

// Run counts only. Whether each answer was right is decided by
// scripts/judge.js, not by the failureTriggered keyword check.
for (const run of loadRuns()) {
  const stats = thisRun.get(run.condition);
  if (stats) stats.total++;
}
console.log("\nRuns:");
printTable([...thisRun.values()]);
console.log(
  `\nGroq usage this run: ${llmStats.requests} requests, ${llmStats.tokens} tokens, ${llmStats.rateLimitWaits} rate-limit waits.`,
);
console.log("Label the answers with: npm run judge");

if (stopReason) {
  console.error(`\n${stopReason}`);
  process.exitCode = 1;
}
