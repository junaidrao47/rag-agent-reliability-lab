import "dotenv/config";
import { Lemma } from "@uselemma/tracing";

// Reads LEMMA_API_KEY and LEMMA_PROJECT_ID from the environment (.env).
const lemma = new Lemma();

async function supportAgent(question) {
  // lemma.trace sends the trace when the callback finishes, and awaiting it
  // waits for delivery, so no sleep is needed before the process exits.
  return lemma.trace(
    { name: "agent-failure-lab", input: question },
    async () => {
      return "Refunds are accepted within 30 days of delivery.";
    },
  );
}

const answer = await supportAgent("What is your refund policy?");
console.log("Agent said:", answer);
console.log("Done. Check the Lemma dashboard.");
