# Agent Failure Lab

A customer-support RAG agent for a fictional store, Northwind Goods, built to
test Lemma's agent monitoring. It answers policy questions from documents in
MongoDB and looks up orders with a tool. Every agent run sends one trace to
Lemma under the agent name `agent-failure-lab`.

## Run locally

Requirements: Node.js 22+, MongoDB running locally, a free Groq API key, and a
Lemma API key and project ID.

```bash
npm install
cp .env.example .env    # then fill in LEMMA_API_KEY, LEMMA_PROJECT_ID, GROQ_API_KEY
npm run seed            # loads 11 policies and 15 orders; first run downloads the embedding model
npm run dev             # starts the server on http://localhost:3000
```

In a second terminal:

```bash
curl http://localhost:3000/health
curl -X POST http://localhost:3000/chat -H "Content-Type: application/json" -d "{\"question\":\"What is your refund policy?\"}"
npm run ask             # sends 10 test questions and prints the answers
```

`npm run ask` calls the agent directly, so it does not need the server running.
It pauses 8 seconds between questions to stay inside Groq's free-tier limits
and takes about 90 seconds. Set `LEMMA_DEBUG=1` to see each trace being sent.

## Layout

| File | Purpose |
| --- | --- |
| `src/config.js` | Env settings, the five failure flags and the per-request override |
| `src/llm.js` | The only module that calls the model provider |
| `src/retrieval.js` | `retrievePolicies(query, k)`: local embeddings and cosine similarity |
| `src/tools.js` | `lookupOrder(orderId)` and the tool dispatcher |
| `src/agent.js` | The agent loop and its Lemma trace |
| `src/server.js` | `POST /chat` and `GET /health` |
| `scripts/seed.js`, `scripts/ask.js` | Seed data and the test questions |
| `data/questions.json` | 120 experiment questions: 20 per flag and 20 baseline |
| `scripts/run-experiment.js` | Experiment runner, writes `results/runs.jsonl` |

## Failure flags

Five flags, read from the environment in `src/config.js`. All are off by
default and at most one may be on. Each is a quiet bug: the request succeeds
and the answer reads fine, but it is wrong.

| Flag | What breaks |
| --- | --- |
| `STALE_DOC` | Retrieval stops filtering on `isCurrent` and keeps the oldest version of each policy, so refund answers cite 60 days |
| `WRONG_TOOL` | `lookup_order` is not offered to the model, so order questions are answered with no lookup |
| `HALLUCINATE` | A missing order comes back from the tool as a normal order and the "say so if not found" rule is gone, so the agent reports a status for an order that does not exist |
| `IGNORE_RULE` | The refund-window rule in the system prompt is replaced by a customer-happiness line, so out-of-window refunds are approved |
| `TRUNCATE` | Policy context is cut to its first 200 characters, so answers miss conditions and exceptions |

## Experiment

```bash
npm run experiment -- --condition all              # all 120 questions
npm run experiment -- --condition STALE_DOC        # one condition
npm run experiment -- --condition all --limit 2    # first 2 of each condition
```

Each run appends one line to `results/runs.jsonl` (git-ignored) with a random
`runId`, the condition and the answer (plus a rough `failureTriggered` keyword
check that is no longer used; see Labeling below). The
trace carries the same ID as `request.id` and nothing else, so the condition is
only known locally. The runner skips questions already in `runs.jsonl`, waits
2.5 seconds between questions (`EXPERIMENT_DELAY_MS`), and stops with a message
if Groq's daily limit is reached; run the same command again to continue.

## Labeling

```bash
npm run judge
```

`scripts/judge.js` asks the Groq model to grade every row of `runs.jsonl`
against the question's `expectedCorrect` text and the ground truth (30-day
refund window, plus the order record from MongoDB when the question names an
order). It writes `results/labels.jsonl`, one line per `runId` with a verdict
of `correct`, `incorrect` or `evasive` and a one-sentence reason, prints a
condition by verdict table, and writes 15 random rows to
`results/review-sample.md` for checking the judge by hand. It does not run the
agent and sends nothing to Lemma. It is resumable and waits 2.5 seconds
between calls (`JUDGE_DELAY_MS`).
