import "dotenv/config";
import { Lemma } from "@uselemma/tracing";

// One shared client. Reads LEMMA_API_KEY and LEMMA_PROJECT_ID from the
// environment. Set LEMMA_DEBUG=1 to log trace delivery.
export const lemma = new Lemma();
