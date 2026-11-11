// Joins Lemma's issues to the experiment runs and the judge's labels, and
// writes results/scorecard.md.
//
//   node scripts/scorecard.js
//
// Offline: reads results/runs.jsonl, results/labels.jsonl and
// results/lemma-issues.json (from scripts/export-lemma-issues.js). It calls
// no model, does not import the tracing module and sends no traces.
// If README.md contains the scorecard markers, the table between them is
// refreshed with the same text.
import fs from "node:fs";
import path from "node:path";
import {
  CONDITIONS,
  LABELS_FILE,
  RESULTS_DIR,
  ROOT,
  RUNS_FILE,
  formatTable,
  latestRunPerQuestion,
  readJsonl,
} from "./lib/results.js";

const EXPORT_FILE = path.join(RESULTS_DIR, "lemma-issues.json");
const OUT_FILE = path.join(RESULTS_DIR, "scorecard.md");
const README_FILE = path.join(ROOT, "README.md");
const README_START = "<!-- scorecard:start -->";
const README_END = "<!-- scorecard:end -->";
const ORGANIC_QUESTION = "base-15";

if (!fs.existsSync(EXPORT_FILE)) {
  console.error("results/lemma-issues.json is missing. Run: npm run export-issues");
  process.exit(1);
}

// --- Load and join -------------------------------------------------------------

const runs = readJsonl(RUNS_FILE);
const labels = new Map(readJsonl(LABELS_FILE).map((label) => [label.runId, label]));
const lemma = JSON.parse(fs.readFileSync(EXPORT_FILE, "utf8"));

const traceById = new Map(lemma.traces.map((trace) => [trace.id, trace]));
const runTrace = new Map(); // runId -> Lemma trace
const traceRunId = new Map(); // Lemma trace id -> { runId, source }
for (const entry of lemma.run_traces) {
  if (entry.traces.length !== 1) continue;
  runTrace.set(entry.runId, traceById.get(entry.traces[0].id) ?? entry.traces[0]);
  traceRunId.set(entry.traces[0].id, entry);
}

// trace id -> [{ issue, occurrence }]
const occurrencesByTrace = new Map();
for (const issue of lemma.issues) {
  for (const occurrence of issue.occurrences) {
    if (!occurrencesByTrace.has(occurrence.trace_id)) occurrencesByTrace.set(occurrence.trace_id, []);
    occurrencesByTrace.get(occurrence.trace_id).push({ issue, occurrence });
  }
}

const scoredRuns = latestRunPerQuestion(runs);
const scoredIds = new Set(scoredRuns.map((run) => run.runId));

/** Everything known about one run. */
function describe(run) {
  const trace = runTrace.get(run.runId);
  const hits = trace ? (occurrencesByTrace.get(trace.id) ?? []) : [];
  const verdict = labels.get(run.runId)?.verdict ?? "unjudged";
  return {
    run,
    trace,
    verdict,
    failed: verdict === "incorrect" || verdict === "evasive",
    // Lemma has finished issue analysis on this trace.
    analyzed: trace?.issue_extraction?.status === "completed",
    flagged: hits.length > 0,
    hits,
  };
}
const scored = scoredRuns.map(describe);

// --- Numbers -------------------------------------------------------------------

const count = (items, test) => items.filter(test).length;
// Exact fraction first, then the percentage to one decimal.
const rate = (n, d) => (d === 0 ? "n/a" : `${n}/${d} (${((100 * n) / d).toFixed(1)}%)`);

const perCondition = CONDITIONS.map((condition) => {
  const rows = scored.filter((r) => r.run.condition === condition);
  const failed = rows.filter((r) => r.failed);
  const analyzed = rows.filter((r) => r.analyzed);
  const failedAnalyzed = failed.filter((r) => r.analyzed);
  return {
    condition,
    rows,
    scored: rows.length,
    incorrect: count(rows, (r) => r.verdict === "incorrect"),
    evasive: count(rows, (r) => r.verdict === "evasive"),
    failed: failed.length,
    analyzed: analyzed.length,
    pending: rows.length - analyzed.length,
    flagged: count(rows, (r) => r.flagged),
    caught: count(failed, (r) => r.flagged),
    failedAnalyzed: failedAnalyzed.length,
    missed: count(failedAnalyzed, (r) => !r.flagged),
    failedPending: failed.length - failedAnalyzed.length,
    correctFlagged: count(rows, (r) => r.verdict === "correct" && r.flagged),
  };
});

const mainHeaders = [
  "Condition",
  "Scored runs",
  "Incorrect (judge)",
  "Evasive (judge)",
  "Analyzed by Lemma",
  "Flagged by Lemma",
  "Failed runs caught",
  "Detection rate (analyzed failed runs)",
  "Detection rate (all failed runs)",
  "Missed (analyzed, not flagged)",
  "Failed runs not analyzed yet",
];
const mainRows = perCondition.map((c) => [
  c.condition,
  c.scored,
  c.incorrect,
  c.evasive,
  `${c.analyzed}/${c.scored}`,
  c.flagged,
  c.caught,
  rate(c.caught, c.failedAnalyzed),
  rate(c.caught, c.failed),
  c.missed,
  c.failedPending,
]);

const markdownTable = (headers, rows) =>
  [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");

const totalAnalyzed = count(scored, (r) => r.analyzed);
const allTracesAnalyzed = count(lemma.traces, (t) => t.issue_extraction?.status === "completed");
const lastCompleted = lemma.traces
  .map((t) => t.issue_extraction?.completed_at)
  .filter(Boolean)
  .sort()
  .pop();
const coverageNote =
  totalAnalyzed === scored.length
    ? `Lemma had finished issue analysis on all ${scored.length} scored runs when the issues were exported (${lemma.exported_at}).`
    : `**Incomplete analysis:** when the issues were exported (${lemma.exported_at}), Lemma had finished issue analysis on ${totalAnalyzed} of the ${scored.length} scored runs. The other ${scored.length - totalAnalyzed} traces had no analysis result yet, so they are neither catches nor misses. The last analysis in the export completed at ${lastCompleted}.`;

const tableBlock = [
  markdownTable(mainHeaders, mainRows),
  "",
  coverageNote,
  "",
  'A run is "failed" when the judge labeled it incorrect or evasive. "Flagged" means Lemma attached at least one issue to the run\'s trace, whatever the issue says. Scored runs are the latest run per question.',
].join("\n");

// --- Sections --------------------------------------------------------------------

const oneLine = (text, max = 400) => {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
};
const quoteBlock = (text) => `> ${oneLine(text)}`;

// Baseline false positives.
const baseline = perCondition.find((c) => c.condition === "baseline");
const baselineCorrect = baseline.rows.filter((r) => r.verdict === "correct");
const baselineCorrectAnalyzed = baselineCorrect.filter((r) => r.analyzed);
const baselineFalsePositives = baselineCorrect.filter((r) => r.flagged);

// Organic failure.
const organic = scored.find((r) => r.run.questionId === ORGANIC_QUESTION);

// Top issue titles per condition.
function topTitles(rows) {
  const tally = new Map();
  for (const r of rows) {
    for (const { issue } of r.hits) tally.set(issue.name, (tally.get(issue.name) ?? 0) + 1);
  }
  return [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2);
}

// Detection delay: first occurrence on a trace minus the run's timestamp.
const delays = scored
  .filter((r) => r.flagged)
  .map((r) => {
    const first = r.hits.map((h) => h.occurrence.created_at).sort()[0];
    return (new Date(first) - new Date(r.run.timestamp)) / 1000;
  })
  .sort((a, b) => a - b);
const median = (values) =>
  values.length === 0
    ? null
    : values.length % 2
      ? values[(values.length - 1) / 2]
      : (values[values.length / 2 - 1] + values[values.length / 2]) / 2;
const fmtSeconds = (s) => `${Math.floor(s / 60)} min ${Math.round(s % 60)} s (${s.toFixed(1)} s)`;

// Examples: spread across conditions, in file order.
function pickAcrossConditions(items, n) {
  const picked = [];
  const pools = CONDITIONS.map((c) => items.filter((r) => r.run.condition === c));
  for (let round = 0; picked.length < n && pools.some((p) => p.length > round); round++) {
    for (const pool of pools) {
      if (pool[round] && picked.length < n) picked.push(pool[round]);
    }
  }
  return picked;
}
const catches = pickAcrossConditions(scored.filter((r) => r.failed && r.flagged), 3);
const misses = pickAcrossConditions(scored.filter((r) => r.failed && r.analyzed && !r.flagged), 3);

function exampleBlock(r) {
  const lines = [
    `- **${r.run.condition}**, runId \`${r.run.runId}\`, judge: ${r.verdict}`,
    `  - Question: ${oneLine(r.run.question)}`,
    `  - Answer: ${oneLine(r.run.answer)}`,
  ];
  if (r.hits.length) lines.push(`  - Lemma issue: "${r.hits[0].issue.name}"`);
  return lines.join("\n");
}

// Traces that match no scored run.
const unmatchedTraces = lemma.traces.filter((t) => !traceRunId.has(t.id));
const discardedTraces = lemma.traces.filter((t) => traceRunId.get(t.id)?.source === "discarded-runs.jsonl");
const duplicateRuns = runs.filter((run) => !scoredIds.has(run.runId));
const flaggedCount = (traces) => count(traces, (t) => occurrencesByTrace.has(t.id));

// Correct runs that were flagged, outside baseline.
const correctFlaggedElsewhere = scored.filter(
  (r) => r.run.condition !== "baseline" && r.verdict === "correct" && r.flagged,
);

// --- Write -------------------------------------------------------------------------

const out = [];
out.push(
  "# Scorecard: does Lemma catch silent agent failures?",
  "",
  `Generated ${new Date().toISOString()} from \`results/runs.jsonl\` (${runs.length} rows, ${scored.length} scored), \`results/labels.jsonl\` (LLM judge, first-pass rubric) and \`results/lemma-issues.json\` (${lemma.issues.length} issues, ${lemma.issues.reduce((n, i) => n + i.occurrences.length, 0)} occurrences, ${lemma.traces.length} traces, exported ${lemma.exported_at}).`,
  "",
  "## Per condition",
  "",
  tableBlock,
  "",
  "## Baseline false positives",
  "",
  `- Baseline runs judged correct: ${baselineCorrect.length} of ${baseline.scored}; ${baselineCorrectAnalyzed.length} of those had been analyzed by Lemma.`,
  `- Correct baseline runs flagged by Lemma: ${baselineFalsePositives.length}.`,
  ...baselineFalsePositives.map((r) => `  - runId \`${r.run.runId}\`: "${r.hits[0].issue.name}"`),
  "",
  "## Correct runs flagged in other conditions",
  "",
  correctFlaggedElsewhere.length
    ? correctFlaggedElsewhere
        .map(
          (r) =>
            `- **${r.run.condition}**, runId \`${r.run.runId}\`: ${r.hits.map((h) => `"${h.issue.name}"`).join(", ")}\n  - Answer: ${oneLine(r.run.answer, 240)}`,
        )
        .join("\n")
    : "- None.",
  "",
  "## The organic failure (baseline, no flag on)",
  "",
);
if (!organic) {
  out.push(`- No scored run for ${ORGANIC_QUESTION}.`);
} else {
  out.push(
    `- Question \`${ORGANIC_QUESTION}\`, runId \`${organic.run.runId}\`, judge: ${organic.verdict}.`,
    `- Answer: ${oneLine(organic.run.answer, 300)}`,
    `- Lemma trace id: \`${organic.trace?.id ?? "not found"}\`.`,
    `- Flagged by Lemma: **${organic.flagged ? "yes" : organic.analyzed ? "no" : "not analyzed yet"}**.`,
    ...organic.hits.map(
      ({ issue, occurrence }) => `  - "${issue.name}" (${issue.category})\n    ${quoteBlock(occurrence.rationale)}`,
    ),
  );
}
out.push("", "## Most common Lemma issue titles per condition", "");
for (const c of perCondition) {
  const titles = topTitles(c.rows);
  out.push(
    `- **${c.condition}**: ${
      titles.length ? titles.map(([name, n]) => `"${name}" (${n} ${n === 1 ? "run" : "runs"})`).join("; ") : "no issues on scored runs"
    }`,
  );
}
out.push(
  "",
  "## Detection delay",
  "",
  delays.length
    ? `- Median time from a run's timestamp to Lemma's first issue occurrence on its trace: ${fmtSeconds(median(delays))}, over ${delays.length} flagged scored runs (min ${fmtSeconds(delays[0])}, max ${fmtSeconds(delays[delays.length - 1])}).`
    : "- No flagged scored runs, so no delay can be computed.",
  "- Occurrence times come from Lemma's `created_at` on each occurrence; run times are local timestamps in `runs.jsonl`.",
  "",
  "## Example catches",
  "",
  catches.length ? catches.map(exampleBlock).join("\n") : "- None.",
  "",
  "## Example misses (analyzed by Lemma, judged failed, not flagged)",
  "",
  misses.length ? misses.map(exampleBlock).join("\n") : "- None.",
  "",
  "## Excluded from the rates",
  "",
  `- ${unmatchedTraces.length} Lemma traces match no runId (Day 1 and Day 2 traces, the \`npm run ask\` check, one setup error trace); ${flaggedCount(unmatchedTraces)} of them were flagged.`,
  `- ${discardedTraces.length} traces belong to discarded setup runs (\`results/discarded-runs.jsonl\`); ${flaggedCount(discardedTraces)} of them were flagged.`,
  `- ${duplicateRuns.length} earlier duplicate runs (${[...new Set(duplicateRuns.map((r) => r.questionId))].join(", ") || "none"}); only the latest run per question is scored.`,
  "",
);
fs.writeFileSync(OUT_FILE, out.join("\n"));

// Refresh the README copy of the table, if the markers are there.
if (fs.existsSync(README_FILE)) {
  const readme = fs.readFileSync(README_FILE, "utf8");
  const start = readme.indexOf(README_START);
  const end = readme.indexOf(README_END);
  if (start !== -1 && end > start) {
    fs.writeFileSync(
      README_FILE,
      `${readme.slice(0, start + README_START.length)}\n${tableBlock}\n${readme.slice(end)}`,
    );
    console.log("README.md scorecard table refreshed.");
  }
}

console.log(
  formatTable(
    ["condition", "scored", "incorrect", "evasive", "analyzed", "flagged", "caught", "rate (analyzed failed)", "rate (all failed)", "missed", "failed, not analyzed"],
    mainRows,
  ),
);
console.log(`\n${coverageNote.replace(/\*\*/g, "")}`);
console.log(`All traces in project with completed analysis: ${allTracesAnalyzed}/${lemma.traces.length}.`);
console.log(`Wrote ${path.relative(process.cwd(), OUT_FILE)}`);
