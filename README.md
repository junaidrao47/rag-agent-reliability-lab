# RAG Agent Reliability Lab

An open test of whether [Lemma](https://uselemma.ai) catches silent AI-agent
failures. I built a small customer-support agent on Lemma's own
`@uselemma/tracing` SDK, shipped five realistic bugs that return fluent,
confident, wrong answers with no errors, ran 20 questions per bug plus a
healthy baseline, and compared what Lemma flagged against independent labels.
Nothing sent to Lemma says which runs were broken.

## Scorecard

<!-- scorecard:start -->
| Condition | Scored runs | Incorrect (judge) | Evasive (judge) | Analyzed by Lemma | Flagged by Lemma | Failed runs caught | Detection rate (analyzed failed runs) | Detection rate (all failed runs) | Missed (analyzed, not flagged) | Failed runs not analyzed yet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| STALE_DOC | 20 | 20 | 0 | 20/20 | 19 | 19 | 19/20 (95.0%) | 19/20 (95.0%) | 1 | 0 |
| WRONG_TOOL | 20 | 2 | 18 | 4/20 | 0 | 0 | 0/4 (0.0%) | 0/20 (0.0%) | 4 | 16 |
| HALLUCINATE | 20 | 19 | 1 | 6/20 | 1 | 1 | 1/6 (16.7%) | 1/20 (5.0%) | 5 | 14 |
| IGNORE_RULE | 20 | 11 | 2 | 8/20 | 8 | 6 | 6/6 (100.0%) | 6/13 (46.2%) | 0 | 7 |
| TRUNCATE | 20 | 0 | 18 | 5/20 | 1 | 1 | 1/5 (20.0%) | 1/18 (5.6%) | 4 | 13 |
| baseline | 20 | 1 | 2 | 5/20 | 1 | 1 | 1/1 (100.0%) | 1/3 (33.3%) | 0 | 2 |

**Incomplete analysis:** when the issues were exported (2026-11-11T07:13:06.189Z), Lemma had finished issue analysis on 48 of the 120 scored runs. The other 72 traces had no analysis result yet, so they are neither catches nor misses. The last analysis in the export completed at 2026-11-11T06:41:52.675Z.

A run is "failed" when the judge labeled it incorrect or evasive. "Flagged" means Lemma attached at least one issue to the run's trace, whatever the issue says. Scored runs are the latest run per question.
<!-- scorecard:end -->

The full scorecard, with example catches and misses and the issue titles Lemma
used, is generated into `results/scorecard.md` by `npm run scorecard`.

![Lemma dashboard after the experiment](screenshots/dashboard-1152.png)

## The five failures

Each one is a bug a real team could ship. The request succeeds, no span
errors, and the answer reads fine.

| Flag | What goes wrong |
| --- | --- |
| `STALE_DOC` | Retrieval serves a superseded policy, so the agent says the refund window is 60 days. It is 30. |
| `WRONG_TOOL` | The order-lookup tool is never offered to the model, so order questions get no real answer. |
| `HALLUCINATE` | An order that does not exist comes back looking like a normal order, and the agent reports a status for it. |
| `IGNORE_RULE` | A prompt edit replaces the refund-window rule with a "keep customers happy" line, so the agent approves refunds it should refuse. |
| `TRUNCATE` | The policy text is cut to its first 200 characters, so answers lose fees, deadlines and exceptions. |

## How it works

- **Agent:** Express server, MongoDB for policies and orders, Groq
  (`openai/gpt-oss-120b`, free tier) for the model, and local embeddings
  (`Xenova/all-MiniLM-L6-v2`) for retrieval. The store, Northwind Goods, is
  fictional.
- **Tracing:** every agent run sends one trace through the official
  `@uselemma/tracing` package (`src/tracing.js`, `src/agent.js`): a retrieval
  span, the model calls, and any tool calls.
- **Blind conditions:** the experiment runner turns on one flag per request
  through an in-process override. The flag name never appears in a prompt,
  span or attribute.
- **Linking runs to traces:** each run gets a random `runId`. It is written to
  `results/runs.jsonl` next to the condition, and attached to the trace as
  `request.id`. That ID is the only link between a trace and its condition.
- **Ground truth:** `scripts/judge.js` asks the Groq model to label every
  answer correct, incorrect or evasive, given the expected answer and the real
  order record. Judge calls are not traced.
- **Scoring:** `scripts/export-lemma-issues.js` reads Lemma's issues through
  its MCP server, and `scripts/scorecard.js` joins issues, runs and labels.

## Run it yourself

Requirements: Node.js 22+, MongoDB running locally, a free Groq API key, and a
Lemma API key, MCP key and project ID.

```bash
npm install
cp .env.example .env         # fill in the keys
npm run seed                 # 11 policies and 15 orders; first run downloads the embedding model
npm run dev                  # server on http://localhost:3000 (POST /chat)
npm run ask                  # 10 healthy test questions, 10 traces
npm run experiment -- --condition all    # 120 questions, 120 traces
npm run judge                # label every run; no traces
npm run export-issues        # read Lemma's issues through its MCP server
npm run scorecard            # write results/scorecard.md
```

The experiment and the judge are resumable and pace themselves for Groq's free
tier. The judge alone used about 86,000 tokens of the 200,000 daily limit.
Everything under `results/` is git-ignored.

## What I'd improve about Lemma

Specifics and evidence for each are in [NOTES.md](NOTES.md).

1. **No sign that analysis is pending.** The dashboard showed 123 traces and
   0 issues, then 165 traces and 32 issues twenty minutes later, with nothing
   in between to say review was still running. "0 issues" reads as "all
   clear". ![0 issues while analysis was pending](screenshots/dashboard-1132.png)
2. **The plan step can lock during signup.** All three plan buttons sat on
   "Checking permissions..." and could not be clicked.
   ![Plan step stuck](screenshots/plan-step-checking-permissions.png)
3. **The starter script used exports that the published SDK does not have**,
   so the very first run crashed and sent no trace.
4. **A failed run always ships an error trace.** There is no way to discard a
   trace once started, so setup mistakes end up in the project.
5. **`trace.output()` is silently ignored** in the callback form of
   `lemma.trace`; the callback's return value replaces it.
6. **No free plan**, and the trial converts to paid unless cancelled.

What worked well: the first trace arrived the same night, awaiting
`lemma.trace(...)` needs no flush, and issues were detected without my adding
any context about the agent.

## Caveats

- **Small sample.** 20 questions per condition, one run each, one model.
- **Open-model agent.** The agent runs on a free-tier open model, which also
  fails on its own: one baseline run approved a refund on a 45-day-old order
  with every flag off.
- **The judge is an LLM.** Labels come from the same Groq model, first-pass
  rubric. Checking its verdicts by hand, I found it too strict in places: it
  marked three complete answers "evasive" for leaving out details nobody
  asked for.
- **"Flagged" is generous.** A run counts as flagged if Lemma attached any
  issue to its trace, even one about something other than the injected bug.
- **Analysis coverage.** The scorecard only counts a miss when Lemma had
  finished analyzing the trace. See the note under the table.
- **Not every bug fired.** `IGNORE_RULE` produced a wrong answer on 11 of 20
  questions; the judge's counts in the table are the real denominator.
- **One design caveat.** In `HALLUCINATE` the false order status comes out of
  the tool, so the trace is self-consistent apart from an empty item list.

## Credit

Built independently to evaluate [Lemma](https://uselemma.ai). I have no
affiliation with Lemma and they did not review this before publication.
Licensed under [MIT](LICENSE).
