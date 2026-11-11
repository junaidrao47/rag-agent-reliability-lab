# Project log: Agent Failure Lab (Lemma evaluation)

Times are PKT (UTC+5). Timestamps inside `results/*.jsonl` are UTC.
Sources: (user) = observed by me in the browser or dashboard; (repo) = code or files in this folder; (session) = console output of the Claude Code build session, not saved to a file.

## 1. Summary

- A customer-support RAG agent for a fictional store (Northwind Goods), built to test whether Lemma detects silent agent failures.
- Stack: Node 22, Express, MongoDB, Groq free tier (`openai/gpt-oss-120b`), local embeddings, official `@uselemma/tracing` 7.12.5.
- Status on 2026-11-11: five failure flags built, 127 experiment runs recorded, dashboard shows 165 traces and 32 issues.
- Labeling: a first judge pass covers all 127 runs; a second pass with a tighter rubric stopped at 48 when Groq's daily token limit was reached.
- Open: issues have not been matched to runs yet, and nothing is committed to git.

## 2. Timeline

### Day 1: 2026-11-10 (evening) into the night

What I did
- Signed up at platform.uselemma.ai; self-serve, no waitlist; onboarding has 6 steps. (user)
- Installed the two Lemma skills, `lemma-tracing` and `lemma-artifacts`, from `uselemma/lemma`. (repo: `skills-lock.json`, last modified 2026-11-11 00:02)
- Sent a first trace from the starter script. (repo: `agent.mjs`, last modified 2026-11-11 00:32)

What worked
- First trace reached the dashboard the same night. (user)
- Awaiting `lemma.trace(...)` waits for delivery, so the script needs no sleep or flush before exit. (repo: comment at `agent.mjs:9`)

Problems hit
- Step 3 (Choose your plan): all three plan buttons were stuck on "Checking permissions..." and could not be clicked (Chrome on Windows, several blocker extensions installed). I got past it later. (user; screenshot: plan-step-checking-permissions)
- Plans shown: Lemma Jr. $60/month, Pro 14-day trial, Enterprise. No free plan; the trial converts to paid Pro unless cancelled. (user; screenshot: plan-options)
- Step 5 (Connect your agent) showed `LEMMA_API_KEY=your_api_key_here` as a placeholder next to a real project ID, plus an `npx skills add` command and a prompt for a coding agent. (user; screenshot: connect-your-agent)
- The skill assumes an existing app; I had none yet. (user)

### Day 2: 2026-11-11 (early hours)

What I did
- Built the support agent: Express server, MongoDB, Groq free tier, local embeddings. (repo: `src/`, `scripts/seed.js`, `scripts/ask.js`, last modified 00:47 to 00:49)
- Versions: `@uselemma/tracing` 7.12.5, `openai` 7.55.0, `express` 5.3.0, `mongodb` 7.8.0, `dotenv` 18.0.10, `@huggingface/transformers` 4.3.2, Node v22.23.1. Model `openai/gpt-oss-120b`, embeddings `Xenova/all-MiniLM-L6-v2`. (repo: `node_modules/*/package.json`, `.env.example`)
- Traces go through the official `@uselemma/tracing` package, not a custom client: `src/tracing.js` creates one `new Lemma()`, and `src/agent.js` calls `lemma.trace`, `startSpan`, `startGeneration` and `startTool`. (repo)
- Seed data: 11 policies (one outdated 60-day refund policy) and 15 orders. (repo: `scripts/seed.js`)

What worked
- Dashboard after Day 2: 23 traces, 0 issues. (user)
- One trace per agent run, with a retrieval span, generation spans and tool spans. (repo: `src/agent.js`)

Problems hit (these three entries are dated 2026-11-11 in the original notes; see To verify 2)
- 2026-11-11: The starter `agent.mjs` imported `registerOTel` and `agent` from `@uselemma/tracing`, but 7.12.5 exports neither, so the script crashed on import and no trace was sent. Fixed by using `new Lemma()` and `lemma.trace(...)`. (repo: `agent.mjs`)
- 2026-11-11: In the callback form `lemma.trace(options, fn)`, calling `trace.output(value)` inside the callback has no effect, because the SDK overwrites it with the callback's return value. Workaround: return the answer text from the callback. (repo: comment in `src/agent.js` above `lemma.trace`)
- 2026-11-11: The Lemma MCP server returned 401 because its config used `${LEMMA_MCP_API_KEY}` from the shell environment, and Claude Code does not read `.env`. Fixed by registering the server with the key value directly.

### Day 3: 2026-11-11

What I did
- Implemented five silent-failure flags: STALE_DOC, WRONG_TOOL, HALLUCINATE, IGNORE_RULE, TRUNCATE. (repo: `src/config.js`, `src/retrieval.js`, `src/tools.js`, `src/agent.js`)
- Wrote 120 questions (20 per flag, 20 baseline) and a resumable runner. (repo: `data/questions.json`, `scripts/run-experiment.js`)
- Each run's random `runId` is attached to its trace as `request.id` in trace metadata; the condition name stays local. (repo: `src/agent.js`, `results/runs.jsonl`)
- 11:12 to 11:15: smoke test, 12 runs kept. 11:24 to 11:35: full experiment, 115 runs. (repo: `results/runs.jsonl`, 06:12:57Z to 06:15:17Z and 06:24:02Z to 06:35:30Z)
- Runs per condition in `results/runs.jsonl`: STALE_DOC 20, WRONG_TOOL 20, HALLUCINATE 20, IGNORE_RULE 20, TRUNCATE 20, baseline 27. Total 127, all `runId`s unique. (repo)
- Baseline has 27 rows for 20 questions: `base-14` to `base-20` each appear twice. (repo; my own count was 22, see To verify 3)
- Added a judge script that labels each run correct, incorrect or evasive, without tracing. (repo: `scripts/judge.js`, which does not import `src/tracing.js` or `src/agent.js`)

What worked
- 11:52: dashboard showed 165 traces and 32 issues. (user; screenshot: dashboard-1152)
- These issues were detected without filling in "Add context to sharpen detection"; that to-do was still open. (user)
- Looking a trace up by `request.id` works through the Lemma MCP `search_traces` attribute filter. (session, one runId tried)
- With all flags off, `npm run ask` answered 10/10 with no error spans. (session)
- The 12 kept smoke runs and the `npm run ask` run produced no error spans. (session: SDK debug output)

Problems hit
- 11:32: dashboard showed 123 traces, 0 issues. At 11:52 it showed 165 traces, 32 issues. Nothing in the UI indicated that review was pending in between. (user; screenshot: dashboard-1132)
- 2026-11-11: `lemma.trace()` options accept `metadata` but not `attributes` (spans accept both), so the neutral `request.id` on the root trace had to go in `metadata`. It is still searchable as the attribute key `request.id`. (repo: `node_modules/@uselemma/tracing/dist/client.d.ts`, `TraceOptions`)
- 2026-11-11: A provider error inside the `lemma.trace` callback (Groq 400 "Tool choice is none, but model called a tool") still ships the trace with an ERROR span, and the SDK has no way to discard or suppress a trace once started. One unwanted error trace reached the project during setup. (session: `request.id` 31e1c46d-b846-4fff-af6d-b48214b05458, no row in `runs.jsonl`)
- 2026-11-11: `dist/experiment-mode.js` exports `enableExperimentMode()` with no explanation in the typings or README of what it changes on the wire. I avoided it because I could not tell whether it marks traces. (repo: `node_modules/@uselemma/tracing/dist/experiment-mode.d.ts`)
- 2026-11-11: With `LEMMA_DEBUG=1` the SDK prints about 60 lines per trace to stdout with no compact mode, which buries script output. I had to redirect to a file and grep.
- My local keyword check (`failureTriggered`) proved unreliable: it marked a correct refund refusal as a failure. (repo: `base-16`, runId 7189ad3a-4919-4db7-b038-fbd22549993b, `failureTriggered: true`, answer declines the refund)
- Four smoke runs were made with earlier versions of HALLUCINATE and IGNORE_RULE that did not really fail; they were set aside. Their traces are still in Lemma. (repo: `results/discarded-runs.jsonl`)
- The judge re-run stopped at 48 of 127 when Groq's tokens-per-day limit (200,000) was reached. (repo: `results/labels.jsonl` has 48 rows; session: 429 message)

Why the trace count rose from 123 to 165
- No script other than the agent sends traces. `scripts/judge.js` calls the model directly and does not import the tracing module. (repo)
- 44 rows in `runs.jsonl` have timestamps from 06:32:00Z (11:32 PKT) onward; the last is 06:35:30Z. The rise of 42 is the tail of the full experiment. (repo)
- The total of 165 adds up: 23 after Day 2, 3 from the first smoke attempt (2 kept, 1 error), 10 from the second (6 kept, 4 discarded), 4 from the third, 10 from `npm run ask`, 115 from the full run. (user for 23; repo and session for the rest)
- So 127 traces match a row in `runs.jsonl` and 38 do not: 23 from Day 2, 10 from `npm run ask`, 4 discarded, 1 error.

## 3. Feedback for Lemma

### Onboarding
1. **Plan step can lock.** All three plan buttons stayed on "Checking permissions..." and could not be clicked. Why it matters: a new user cannot finish signup and gets no hint what is wrong. Suggested fix: time out with an error message and a retry, and say so if a browser extension is blocking a request. (Day 1)
2. **No free plan, and the trial converts to paid.** Why it matters: someone evaluating the product has to accept a paid conversion before sending a single trace. Suggested fix: a free tier with a trace cap, or a trial that ends without converting. (Day 1)
3. **Placeholder API key next to a real project ID.** Step 5 showed `LEMMA_API_KEY=your_api_key_here` beside a real project ID. Why it matters: half the snippet is ready to paste and half is not, and it does not say where the key comes from. Suggested fix: fill in a real key, or link to the page that creates one. (Day 1)
4. **The skill assumes an existing app.** Why it matters: a first-time evaluator with no agent has nothing to instrument. Suggested fix: offer a minimal sample agent path. (Day 1)

### SDK and skill
1. **Starter script used exports that do not exist.** `agent.mjs` imported `registerOTel` and `agent`, which 7.12.5 does not export, so the first run crashed and sent no trace. Why it matters: the very first step fails. Suggested fix: test the starter against the published package version. (Day 2 entry 1; origin of the starter is To verify 4)
2. **A failed run always ships an ERROR trace.** There is no way to discard a trace once started. Why it matters: setup mistakes and rate-limit failures pollute the project and its issue counts. Suggested fix: a `trace.discard()` or a "do not send on error" option. (Day 3)
3. **`trace.output()` is silently ignored in the callback form.** The callback's return value replaces it. Why it matters: the root output is wrong with no warning. Suggested fix: honor an explicit `trace.output()`, or warn. (Day 2 entry 2)
4. **Root trace has no `attributes` option.** Only `metadata`; spans have both. Why it matters: it is unclear where a request ID belongs and whether it will be searchable. Suggested fix: accept `attributes` on the trace, or document that metadata keys are searchable. (Day 3)
5. **`LEMMA_DEBUG=1` is very verbose.** About 60 lines per trace. Why it matters: it hides the app's own output while debugging. Suggested fix: a one-line-per-trace mode. (Day 3)
6. **Worked well:** awaiting `lemma.trace(...)` waits for delivery, so no flush or sleep is needed. (Day 1)

### Dashboard and detection
1. **No sign that review is pending.** 123 traces and 0 issues at 11:32, then 165 traces and 32 issues at 11:52, with nothing in between. Why it matters: "0 issues" reads as "nothing wrong" when it means "not analyzed yet". Suggested fix: show an "analyzing N traces" state next to the issue count. The MCP API already returns `issue_extraction.status: "running"` per trace. (Day 3; session for the MCP field)
2. **Worked well:** 32 issues were detected without any added context. (Day 3)

### Docs
1. **`enableExperimentMode()` is undocumented.** Why it matters: a user running experiments cannot tell if it is needed or what it sends. Suggested fix: one paragraph in the README. (Day 3)
2. **MCP key setup.** The config read `${LEMMA_MCP_API_KEY}` from the shell, which Claude Code does not load from `.env`, giving a 401. Why it matters: the error does not point at the cause. Suggested fix: say in the setup docs that the variable must be in the shell environment, or show the direct-value form. (Day 2 entry 3)

## 4. Findings about the experiment itself

- **Judge verdicts, first pass, all 127 runs** (repo: `results/labels-v1.jsonl`; correct / incorrect / evasive): STALE_DOC 0/20/0, WRONG_TOOL 0/2/18, HALLUCINATE 0/19/1, IGNORE_RULE 7/11/2, TRUNCATE 2/0/18, baseline 22/1/4.
- **Keyword check, for comparison only** (repo: `failureTriggered` in `runs.jsonl`): STALE_DOC 19 of 20, WRONG_TOOL 20, HALLUCINATE 18, IGNORE_RULE 14, TRUNCATE 20, baseline 3 of 27. No summary uses this field any more.
- **IGNORE_RULE fired on about half.** 11 of 20 judged incorrect; 7 answers still refused the refund. (repo: `labels-v1.jsonl`)
- **Organic failure with no flag on.** `base-15` (order delivered 45 days ago): runId 31b1c602-5e5b-4e2f-b6d2-af977ab00dda answered "You can still get a refund"; runId 277824b3-cc79-44d1-8468-c72c99971d37 answered "I don't have information on refunds for orders that were delivered that long ago", which is a non-answer rather than a refusal. (repo: `runs.jsonl`)
- **TRUNCATE did not always fail.** Two warranty questions (`detail-08`, `detail-19`) were judged correct despite the cut context. (repo)
- **One fallback answer.** `window-16`, runId 52df84cd-87ce-4de3-bec3-e31f301a915a, returned "Sorry, I couldn't complete that request. Please try again." (repo)
- **Baseline duplicates.** `base-14` to `base-20` ran twice; the two `base-15` rows are 0.7 seconds apart, so two runner processes overlapped. (repo: timestamps 06:34:22.343Z and 06:34:23.019Z)
- **WRONG_TOOL needed a prompt change.** With the tool removed but still named in the system prompt, Groq returned a 400. The tool instructions now drop out with the tool. (repo: `buildSystemPrompt` in `src/agent.js`)
- **HALLUCINATE caveat.** The false "processing" status originates in the tool output (default values for a missing order), so the trace is self-consistent apart from empty items and a null order date. (repo: `lookup_order` handler in `src/tools.js`)
- **The judge is noisy.** In the first pass it marked three complete baseline answers evasive (`base-07`, both `base-18`) for omitting details not asked for, and marked two "I don't have the status" answers incorrect (`tool-09`, `tool-10`). (repo: `labels-v1.jsonl`)
- **Two label files exist.** `labels-v1.jsonl`: 127 rows, original rubric. `labels.jsonl`: 48 rows, tightened rubric, matches the current `scripts/judge.js`. On those 48, two verdicts differ from v1. (repo; session for the comparison)
- **38 of 165 traces have no row in `runs.jsonl`.** Any Lemma issue raised on those cannot be scored against a condition.
- **Nothing is committed.** The git repository has no commits, so there is no history to cite. (repo: `git log`)

## 5. To verify

1. What actually fixed the stuck "Checking permissions..." plan buttons on Day 1?
2. The first three SDK entries are dated 2026-11-11. Did the starter-script crash happen on Day 1 night (before the first trace) or on Day 2? `agent.mjs` was last modified at 00:32 on 2026-11-11.
3. Baseline row count: `runs.jsonl` has 27 baseline rows (7 questions twice), not 22. Was 22 read from somewhere else, or at an earlier moment?
4. Where did the starter `agent.mjs` with the non-existent imports come from: the onboarding prompt, the `lemma-tracing` skill, or a coding agent's own guess?
5. How were two runner processes started at once (the cause of the baseline duplicates)?
6. Which runs do the 32 issues belong to? They have not been matched to `request.id` values yet, so detection per condition is unknown.
7. Did any of the 32 issues land on the 38 traces that have no row in `runs.jsonl`?
8. When did issue extraction finish? Only two dashboard readings exist (11:32 and 11:52).
9. Was the dashboard reading of 123 traces taken at 11:32 exactly? 44 runs are timestamped 11:32:00 or later, against a rise of 42.
10. Which label set is official: finish the tightened rubric (79 runs left) or go back to `labels-v1.jsonl`?
11. Is the judge accurate enough? `results/review-sample-v1.md` (15 rows from all 127) has not been checked by hand.
12. Which plan is the account on, and when does the trial convert?
13. What does `enableExperimentMode()` do?
14. Should the five unmatched Day 3 setup traces (1 error, 4 discarded) be deleted from the Lemma project?
