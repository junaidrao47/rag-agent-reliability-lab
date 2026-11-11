// Shared helpers for reading experiment results. Nothing here calls the
// model or Lemma.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const RESULTS_DIR = path.join(ROOT, "results");
export const QUESTIONS_FILE = path.join(ROOT, "data", "questions.json");
export const RUNS_FILE = path.join(RESULTS_DIR, "runs.jsonl");
export const LABELS_FILE = path.join(RESULTS_DIR, "labels.jsonl");

export const CONDITIONS = ["STALE_DOC", "WRONG_TOOL", "HALLUCINATE", "IGNORE_RULE", "TRUNCATE", "baseline"];
export const VERDICTS = ["correct", "incorrect", "evasive"];

export function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/**
 * One run per questionId: the latest by timestamp. Used for scoring only;
 * the raw rows in runs.jsonl are never changed.
 */
export function latestRunPerQuestion(runs) {
  const latest = new Map();
  for (const run of runs) {
    const current = latest.get(run.questionId);
    if (!current || run.timestamp > current.timestamp) latest.set(run.questionId, run);
  }
  return runs.filter((run) => latest.get(run.questionId) === run);
}

/** Prints an aligned text table. */
export function formatTable(headers, rows) {
  const cells = rows.map((row) => row.map(String));
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((row) => row[i].length)));
  const line = (row) => row.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd();
  return [line(headers), widths.map((w) => "-".repeat(w)).join("  "), ...cells.map(line)].join("\n");
}
