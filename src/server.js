import express from "express";
import { config } from "./config.js";
import { runAgent } from "./agent.js";
import { closeDb } from "./db.js";

const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// POST /chat { question } -> { answer, sources, toolCalls }
// Each request is one agent run and produces one Lemma trace.
app.post("/chat", async (req, res) => {
  const question = req.body?.question;
  if (typeof question !== "string" || !question.trim()) {
    return res.status(400).json({ error: "Body must be { question: string }." });
  }
  try {
    res.json(await runAgent(question.trim()));
  } catch (error) {
    console.error("Agent run failed:", error.message);
    const status = error?.status === 429 ? 429 : 500;
    res.status(status).json({ error: error.message });
  }
});

const server = app.listen(config.port, () => {
  console.log(`Northwind Goods support agent listening on http://localhost:${config.port}`);
});

async function shutdown() {
  server.close();
  await closeDb();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
