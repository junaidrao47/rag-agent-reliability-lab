// Exports every Lemma issue, its occurrences and the trace list through the
// Lemma MCP server, and saves the raw data to results/lemma-issues.json.
//
//   node scripts/export-lemma-issues.js
//
// Read-only: it calls list/search tools only. It does not run the agent, does
// not import the tracing module and sends no traces.
// Needs LEMMA_MCP_API_KEY and LEMMA_PROJECT_ID in .env.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { RESULTS_DIR, RUNS_FILE, readJsonl } from "./lib/results.js";

const MCP_URL = process.env.LEMMA_MCP_URL || "https://api.uselemma.ai/mcp/";
// Tolerates a key pasted with its <angle brackets> from a docs placeholder.
const API_KEY = (process.env.LEMMA_MCP_API_KEY ?? "").trim().replace(/^<|>$/g, "");
const PROJECT_ID = process.env.LEMMA_PROJECT_ID;
const OUT_FILE = path.join(RESULTS_DIR, "lemma-issues.json");
const DISCARDED_FILE = path.join(RESULTS_DIR, "discarded-runs.jsonl");
const CONTEXT =
  "Exporting detected issues and trace identifiers so a project owner can compare them with independently labeled agent runs.";
const PAUSE_MS = 120;

if (!API_KEY || !PROJECT_ID) {
  console.error("Set LEMMA_MCP_API_KEY and LEMMA_PROJECT_ID in .env first.");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Minimal MCP client (streamable HTTP, JSON-RPC) --------------------------

let sessionId = null;
let nextId = 1;

async function rpc(method, params, { notification = false } = {}) {
  const body = { jsonrpc: "2.0", method, ...(params ? { params } : {}) };
  if (!notification) body.id = nextId++;
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${API_KEY}`,
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  sessionId = response.headers.get("mcp-session-id") ?? sessionId;
  if (!response.ok) {
    throw new Error(`MCP ${method} failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  if (notification) return null;
  const text = await response.text();
  // The server may answer with plain JSON or with a server-sent event stream.
  const payloads = (response.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice(5)))
    : [JSON.parse(text)];
  const message = payloads.find((p) => p.id === body.id) ?? payloads[payloads.length - 1];
  if (message?.error) throw new Error(`MCP ${method} error: ${JSON.stringify(message.error).slice(0, 300)}`);
  return message.result;
}

async function callTool(name, args) {
  await sleep(PAUSE_MS);
  const result = await rpc("tools/call", { name, arguments: { ...args, context: CONTEXT } });
  const text = (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
  if (result.isError) throw new Error(`${name} failed: ${text.slice(0, 300)}`);
  return result.structuredContent ?? JSON.parse(text);
}

// --- Export ------------------------------------------------------------------

await rpc("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "issue-export", version: "1.0.0" },
});
await rpc("notifications/initialized", undefined, { notification: true });

// 1. Every issue, any status.
const issues = [];
let cursor;
do {
  const page = await callTool("list_issues", {
    project_id: PROJECT_ID,
    response_version: 2,
    status: "all",
    include_below_cutoff: true,
    limit: 100,
    max_bytes: 65536,
    ...(cursor ? { cursor } : {}),
  });
  issues.push(...page.sections.issues.items);
  cursor = page.sections.issues.next_cursor;
} while (cursor);
console.log(`Issues: ${issues.length}`);

// 2. Every occurrence of every issue (this is where trace ids and the
//    per-trace description live).
for (const issue of issues) {
  issue.occurrences = [];
  for (let offset = 0; ; offset += 100) {
    const page = await callTool("list_issue_occurrences", { issue_id: issue.id, limit: 100, offset });
    issue.occurrences.push(...page.occurrences);
    if (!page.has_more) break;
  }
}
console.log(`Occurrences: ${issues.reduce((n, issue) => n + issue.occurrences.length, 0)}`);

// 3. Every trace in the project.
const traces = [];
let traceCursor;
let traceTotal = null;
do {
  const page = await callTool("list_traces", {
    project_id: PROJECT_ID,
    limit: 100,
    include_unprocessed: true,
    ...(traceCursor ? { cursor: JSON.stringify(traceCursor) } : {}),
  });
  traces.push(...page.data);
  traceTotal = page.total ?? traceTotal;
  traceCursor = page.data.length ? page.next_cursor : null;
} while (traceCursor && traces.length < (traceTotal ?? Infinity));
console.log(`Traces: ${traces.length} listed, ${traceTotal} reported by Lemma`);

// 4. runId -> trace, through the request.id attribute on each trace.
const runIds = [
  ...readJsonl(RUNS_FILE).map((run) => ({ runId: run.runId, source: "runs.jsonl" })),
  ...readJsonl(DISCARDED_FILE).map((run) => ({ runId: run.runId, source: "discarded-runs.jsonl" })),
];
const runTraces = [];
for (const [index, { runId, source }] of runIds.entries()) {
  const found = await callTool("search_traces", {
    project_id: PROJECT_ID,
    attribute_filters: [{ key: "request.id", values: [{ kind: "string", value: runId }] }],
    limit: 5,
  });
  runTraces.push({
    runId,
    source,
    traces: found.result.map((t) => ({ id: t.id, otel_trace_id: t.otel_trace_id, timestamp: t.timestamp })),
  });
  if ((index + 1) % 25 === 0) console.log(`  matched ${index + 1}/${runIds.length} run ids`);
}
const unmatched = runTraces.filter((r) => r.traces.length !== 1);
console.log(`Run ids with exactly one trace: ${runTraces.length - unmatched.length}/${runTraces.length}`);

fs.mkdirSync(RESULTS_DIR, { recursive: true });
fs.writeFileSync(
  OUT_FILE,
  JSON.stringify(
    {
      exported_at: new Date().toISOString(),
      source: "Lemma MCP server",
      tools: ["list_issues", "list_issue_occurrences", "list_traces", "search_traces"],
      trace_total_reported: traceTotal,
      issues,
      traces,
      run_traces: runTraces,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Wrote ${path.relative(process.cwd(), OUT_FILE)}`);
