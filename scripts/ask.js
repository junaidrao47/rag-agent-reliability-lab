// Sends 10 test questions to the agent (in-process, no server needed) and
// prints the answers. Each question produces one Lemma trace.
import { runAgent } from "../src/agent.js";
import { closeDb } from "../src/db.js";

// Free tier allows about 30 requests and 8,000 tokens per minute, so pause
// between questions. Override with ASK_DELAY_MS.
const DELAY_MS = Number(process.env.ASK_DELAY_MS) || 8000;

const questions = [
  // Policy
  { type: "policy", text: "What is your refund policy? How many days do I have?" },
  { type: "policy", text: "How long does standard shipping take, and is it free?" },
  { type: "policy", text: "Do you ship to Canada, and who pays customs fees?" },
  { type: "policy", text: "When is customer support open?" },
  // Order lookups
  { type: "order", text: "Where is my order NW-1002?" },
  { type: "order", text: "What did I buy in order NW-1007 and when was it delivered?" },
  { type: "order", text: "Was order NW-1005 cancelled?" },
  { type: "order", text: "What's the status of order NW-9999?" }, // does not exist
  // Mixed: needs the order and the policy
  { type: "mixed", text: "Can I still get a refund for order NW-1004?" },
  { type: "mixed", text: "I want to cancel order NW-1013. Is that still possible?" },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
for (const [index, question] of questions.entries()) {
  console.log(`\n[${index + 1}/${questions.length}] (${question.type}) ${question.text}`);
  try {
    // runAgent resolves only after its trace has been delivered to Lemma.
    const { answer, sources, toolCalls } = await runAgent(question.text);
    console.log(`Answer: ${answer}`);
    console.log(`Sources: ${sources.map((s) => `${s.title} v${s.version}`).join(", ")}`);
    console.log(
      `Tool calls: ${
        toolCalls.length
          ? toolCalls.map((t) => `${t.name}(${JSON.stringify(t.arguments)})`).join(", ")
          : "none"
      }`,
    );
  } catch (error) {
    failures++;
    console.error(`Failed: ${error.message}`);
  }
  if (index < questions.length - 1) await sleep(DELAY_MS);
}

await closeDb();
console.log(
  `\nDone: ${questions.length - failures}/${questions.length} answered, ${questions.length} traces sent to Lemma.`,
);
process.exitCode = failures ? 1 : 0;
