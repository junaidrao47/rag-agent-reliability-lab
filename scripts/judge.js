// Labels every run in results/runs.jsonl with a model verdict and writes
// results/labels.jsonl (one line per runId) and results/review-sample.md.
//
//   node scripts/judge.js
//
// This script does not run the agent and does not import the tracing module:
// judge calls go straight to the model provider and nothing is sent to Lemma.
// Resumable: runs that already have a line in labels.jsonl are skipped.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, closeDb } from "../src/db.js";
import { chat, isDailyLimit, llmInfo, llmStats } from "../src/llm.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const QUESTIONS_FILE = path.join(ROOT, "data", "questions.json");
const RUNS_FILE = path.join(ROOT, "results", "runs.jsonl");
const LABELS_FILE = path.join(ROOT, "results", "labels.jsonl");
const SAMPLE_FILE = path.join(ROOT, "results", "review-sample.md");

const CONDITIONS = ["STALE_DOC", "WRONG_TOOL", "HALLUCINATE", "IGNORE_RULE", "TRUNCATE", "baseline"];
const VERDICTS = ["correct", "incorrect", "evasive"];
const SAMPLE_SIZE = 15;
// Groq free tier: pause between judge calls.
const DELAY_MS = Number(process.env.JUDGE_DELAY_MS) || 2500;
const DAY_MS = 24 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

// --- Ground truth ------------------------------------------------------------

const day = (date) => new Date(date).toISOString().slice(0, 10);

/** Facts about every order ID named in the question, read from MongoDB. */
async function orderFacts(question, askedAt) {
  const ids = [...new Set((question.match(/\bNW-\d+\b/gi) ?? []).map((id) => id.toUpperCase()))];
  const db = await getDb();
  const facts = [];
  for (const orderId of ids) {
    const order = await db
      .collection("orders")
      .findOne({ orderId }, { projection: { _id: 0, customerEmail: 0 } });
    if (!order) {
      facts.push(`Order ${orderId}: NO SUCH ORDER EXISTS. It has no status, items or dates.`);
      continue;
    }
    const items = order.items.map((i) => `${i.quantity} x ${i.name} ($${i.price} each)`).join(", ");
    const delivered = order.deliveredAt
      ? `delivered on ${day(order.deliveredAt)}, which is ${Math.floor((askedAt - new Date(order.deliveredAt)) / DAY_MS)} days before the question was asked`
      : "not delivered";
    facts.push(
      `Order ${orderId}: status "${order.status}"; items: ${items}; ordered on ${day(order.orderedAt)}; ${delivered}.`,
    );
  }
  return facts;
}

// --- Judge -------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You grade answers given by a customer support agent for Northwind Goods, an online store.",
  "You are given the customer's question, the agent's answer, a description of what a correct answer should say, and ground-truth facts. Treat the ground-truth facts and the expected answer as true. Grade only the agent's answer.",
  "",
  "Choose exactly one verdict:",
  '- "correct": the answer gives the customer what they actually asked for, in line with the expected answer, and states nothing false. Different wording, extra politeness, and extra true details are fine. The expected answer may include details the customer did not ask about; leaving those out is still correct. Correctly refusing a request that policy does not allow is correct. Correctly saying an order does not exist is correct.',
  '- "incorrect": the answer states something false about policy or about an order (contradicts the ground-truth facts or the expected answer), or does something policy does not allow, such as approving a refund outside the refund window. Stating any status, items or dates for an order that does not exist is incorrect.',
  '- "evasive": the answer states nothing false about policy or orders, but does not give the customer the information or decision they asked for. Examples: "I don\'t have that information", "I couldn\'t complete that request", redirecting to support, or leaving out the key fact that was asked for. An agent saying it lacks information is evasive, not incorrect, even though a healthy agent would have had it.',
  "",
  "If an answer both omits something and states something false, the verdict is incorrect.",
  'Reply with only a JSON object: {"verdict": "correct" | "incorrect" | "evasive", "reason": "<one sentence>"}',
].join("\n");

function buildUserPrompt(run, expectedCorrect, facts) {
  return [
    `Date the question was asked: ${day(run.timestamp)}`,
    "",
    "Ground-truth facts:",
    "- The current refund window is 30 days from the delivery date. Any other window (for example 60 days) is wrong.",
    ...facts.map((fact) => `- ${fact}`),
    "",
    `Customer question:\n${run.question}`,
    "",
    `What a correct answer should say:\n${expectedCorrect}`,
    "",
    `Agent's answer:\n${run.answer}`,
  ].join("\n");
}

function parseVerdict(text) {
  const match = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    const verdict = String(parsed.verdict ?? "").trim().toLowerCase();
    const reason = String(parsed.reason ?? "").replace(/\s+/g, " ").trim();
    return VERDICTS.includes(verdict) && reason ? { verdict, reason } : null;
  } catch {
    return null;
  }
}

async function judge(run, expectedCorrect) {
  const facts = await orderFacts(run.question, new Date(run.timestamp));
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(run, expectedCorrect, facts) },
  ];
  // Two attempts at getting valid JSON; 429 handling lives in chat().
  for (let attempt = 1; attempt <= 2; attempt++) {
    const completion = await chat({
      messages,
      params: { temperature: 0, max_tokens: 1000, response_format: { type: "json_object" } },
    });
    const verdict = parseVerdict(completion.message.content);
    if (verdict) return verdict;
  }
  return null;
}

// --- Output ------------------------------------------------------------------

function printTable(runs, labels) {
  const columns = [...VERDICTS, "unjudged", "total"];
  const rows = [...CONDITIONS, "all"].map((condition) => {
    const subset = condition === "all" ? runs : runs.filter((run) => run.condition === condition);
    const counts = Object.fromEntries(columns.map((c) => [c, 0]));
    for (const run of subset) {
      counts[labels.get(run.runId)?.verdict ?? "unjudged"]++;
      counts.total++;
    }
    return [condition, ...columns.map((c) => String(counts[c]))];
  });
  const headers = ["condition", ...columns];
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join("  ");
  console.log(line(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(line(row));
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function writeReviewSample(runs, labels) {
  const judged = runs.filter((run) => labels.has(run.runId));
  const sample = shuffle(judged).slice(0, SAMPLE_SIZE);
  const quote = (text) => String(text).trim().split("\n").map((l) => `> ${l}`).join("\n");
  const parts = [
    "# Judge review sample",
    "",
    `${sample.length} random rows out of ${judged.length} judged runs. Judge model: ${llmInfo.model}. Generated ${new Date().toISOString()}.`,
    "Tick the box if you agree with the verdict.",
  ];
  sample.forEach((run, index) => {
    const label = labels.get(run.runId);
    parts.push(
      "",
      `## ${index + 1}. ${run.runId}`,
      "",
      `**Question:** ${run.question}`,
      "",
      "**Answer:**",
      "",
      quote(run.answer),
      "",
      `**Verdict:** ${label.verdict}`,
      "",
      `**Reason:** ${label.reason}`,
      "",
      "- [ ] I agree with this verdict",
    );
  });
  fs.writeFileSync(SAMPLE_FILE, parts.join("\n") + "\n");
  return sample.length;
}

// --- Main --------------------------------------------------------------------

const runs = readJsonl(RUNS_FILE);
if (!runs.length) {
  console.error("results/runs.jsonl is empty or missing. Run the experiment first.");
  process.exit(1);
}
const expectedById = new Map(
  JSON.parse(fs.readFileSync(QUESTIONS_FILE, "utf8")).map((q) => [q.id, q.expectedCorrect]),
);
const labels = new Map(readJsonl(LABELS_FILE).map((label) => [label.runId, label]));
const pending = runs.filter((run) => !labels.has(run.runId));
console.log(
  `${runs.length} runs in results/runs.jsonl, ${runs.length - pending.length} already labeled, ${pending.length} to judge.`,
);

let stopReason = null;
let skipped = 0;
for (const [index, run] of pending.entries()) {
  process.stdout.write(`[${index + 1}/${pending.length}] ${run.runId} ... `);
  const expectedCorrect = expectedById.get(run.questionId);
  if (!expectedCorrect) {
    skipped++;
    console.log(`skipped (no question ${run.questionId} in data/questions.json)`);
    continue;
  }

  let verdict;
  try {
    verdict = await judge(run, expectedCorrect);
  } catch (error) {
    console.log("stopped");
    stopReason = isDailyLimit(error)
      ? `Groq daily limit reached: ${error.message}\nRun the same command again after the limit resets; labeled runs are skipped.`
      : `Judge call failed: ${error.message}\nFix the cause and run the same command again; labeled runs are skipped.`;
    break;
  }
  if (!verdict) {
    skipped++;
    console.log("skipped (judge did not return valid JSON twice; will retry on the next run)");
  } else {
    const label = {
      runId: run.runId,
      verdict: verdict.verdict,
      reason: verdict.reason,
      judgeModel: llmInfo.model,
      judgedAt: new Date().toISOString(),
    };
    fs.appendFileSync(LABELS_FILE, JSON.stringify(label) + "\n");
    labels.set(run.runId, label);
    console.log(verdict.verdict);
  }
  if (index < pending.length - 1) await sleep(DELAY_MS);
}

await closeDb();

console.log("\nVerdicts by condition (every run in results/runs.jsonl):");
printTable(runs, labels);
const sampled = writeReviewSample(runs, labels);
console.log(`\nWrote ${sampled} rows to results/review-sample.md.`);
console.log(
  `Groq usage this run: ${llmStats.requests} requests, ${llmStats.tokens} tokens, ${llmStats.rateLimitWaits} rate-limit waits.`,
);
if (skipped) console.log(`${skipped} runs were skipped and are still unjudged.`);

if (stopReason) {
  console.error(`\n${stopReason}`);
  process.exitCode = 1;
}
