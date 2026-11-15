# RAG Agent Reliability Lab

An open test of whether [Lemma](https://uselemma.ai) catches silent AI-agent
failures. I built a small customer-support agent on Lemma's own
`@uselemma/tracing` SDK, shipped five realistic bugs that return fluent,
confident, wrong answers with no errors, ran 20 questions per bug plus a
healthy baseline, and compared what Lemma flagged against independent labels.
Nothing sent to Lemma says which runs were broken.

> **Read this first: Lemma analyzed only 48 of the 120 runs, then stopped.**
> The last analysis finished on 2026-11-11. Four days later the count had not
> moved. The dashboard overview still says "165 Total traces processed" and
> shows nothing pending, stalled or failed. Every result below reflects that
> partial coverage: one condition was fully analyzed, and the other five were
> not.

## Scorecard

<!-- scorecard:start -->
**Incomplete analysis:** when the issues were exported (2026-11-15T06:09:47.716Z), Lemma had finished issue analysis on 48 of the 120 scored runs. The other 72 traces had no analysis result (the API returns `issue_extraction: null` for them), so they are neither catches nor misses. The last analysis completed at 2026-11-11T06:41:52.675Z, and no trace was analyzed in the 4 days between then and the export.

### The one complete result: STALE_DOC

**STALE_DOC: Lemma caught 19/20 (95.0%) of the failed runs.** It analyzed all 20 runs in this condition. The judge marked 20 of them as failed; Lemma flagged 19 and missed 1.

This is the only condition where a detection rate can be stated with confidence.

### Partial: analysis incomplete

Lemma analyzed only some of the runs in these conditions and then stopped. Each row says what happened on the runs it did analyze. None of these is a detection rate for the condition.

| Condition | Analyzed by Lemma | Failed runs among those analyzed | Caught | Missed | Failed runs never analyzed |
| --- | --- | --- | --- | --- | --- |
| WRONG_TOOL | only 4 of 20 | 4 | 0 of 4 analyzed | 4 of 4 analyzed | 16 of 20 failed runs |
| HALLUCINATE | only 6 of 20 | 6 | 1 of 6 analyzed | 5 of 6 analyzed | 14 of 20 failed runs |
| IGNORE_RULE | only 8 of 20 | 6 | 6 of 6 analyzed | 0 of 6 analyzed | 7 of 13 failed runs |
| TRUNCATE | only 5 of 20 | 5 | 1 of 5 analyzed | 4 of 5 analyzed | 13 of 18 failed runs |
| baseline | only 5 of 20 | 1 | 1 of 1 analyzed | 0 of 1 analyzed | 2 of 3 failed runs |

- **These are not proven misses.** A row like "0 of 4 analyzed" means Lemma looked at four failed runs and raised no issue on them. It says nothing about the failed runs it never analyzed.
- **The analyzed runs are not a random sample.** They are the runs Lemma reached before it stopped, so they may not represent the condition.
- **IGNORE_RULE:** Lemma also flagged 2 runs that the judge marked correct.
- **False positives on baseline:** 4 of the 17 correct baseline runs were analyzed, and Lemma flagged 0 of them.

A run is "failed" when the judge labeled it incorrect or evasive. "Flagged" means Lemma attached at least one issue to the run's trace, whatever the issue says. Scored runs are the latest run per question.
<!-- scorecard:end -->

The full per-condition table, with example catches and misses and the issue
titles Lemma used, is generated into `results/scorecard.md` by
`npm run scorecard`. Its partial rows carry the same coverage caveat.

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

1. **Analysis stopped silently, and the dashboard says everything was
   processed.** Lemma finished issue analysis on 86 of the project's 165
   traces (48 of the 120 scored runs) and then stopped. The last analysis
   completed on 2026-11-11 at 06:41 UTC. An export four days later, on
   2026-11-15, showed the same 86. The dashboard overview reads "165 Total
   traces processed" and 32 issues, with no pending, stalled or failed state.
   The only hint I found is on the Traces page: a "Show unprocessed" toggle,
   and unanalyzed rows drawn in dimmer text, with no count, no reason and no
   way to retry. The API returns `issue_extraction: null` for those traces
   rather than a status. A tool built to catch silent failures skipped 79
   traces without saying so, which is the same class of failure.
2. **No sign that analysis is pending.** Earlier, the dashboard showed 123
   traces and 0 issues, then 165 traces and 32 issues twenty minutes later,
   with nothing in between to say review was still running. "0 issues" reads
   as "all clear".
3. **The plan step can lock during signup.** All three plan buttons sat on
   "Checking permissions..." and could not be clicked.
4. **The starter script used exports that the published SDK does not have**,
   so the very first run crashed and sent no trace.
5. **A failed run always ships an error trace.** There is no way to discard a
   trace once started, so setup mistakes end up in the project.
6. **`trace.output()` is silently ignored** in the callback form of
   `lemma.trace`; the callback's return value replaces it.
7. **No free plan**, and the trial converts to paid unless cancelled.

What worked well: the first trace arrived the same night, awaiting
`lemma.trace(...)` needs no flush, and issues were detected without my adding
any context about the agent. On the one condition it fully analyzed, Lemma
caught 19 of 20 failures.

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
- **Analysis coverage.** Lemma analyzed 48 of the 120 scored runs. A miss is
  only counted when Lemma had finished analyzing the trace, and the 72
  unanalyzed runs are neither catches nor misses. The analyzed runs are the
  ones Lemma reached before it stopped, not a random sample.
- **I don't know why analysis stopped.** It could be a trial limit, a queue
  fault or something else. I did not contact Lemma before publishing, and I
  sent no further traces after the experiment.
- **Not every bug fired.** `IGNORE_RULE` produced a wrong answer on 11 of 20
  questions; the judge's counts in the table are the real denominator.
- **One design caveat.** In `HALLUCINATE` the false order status comes out of
  the tool, so the trace is self-consistent apart from an empty item list.

## Credit

Built independently to evaluate [Lemma](https://uselemma.ai). I have no
affiliation with Lemma and they did not review this before publication.
Licensed under [MIT](LICENSE).
