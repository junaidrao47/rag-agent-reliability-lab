import { pipeline } from "@huggingface/transformers";
import { config } from "./config.js";

let extractorPromise;

// The model is downloaded once on first use and cached locally. No API calls.
function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", config.embeddingModel);
  }
  return extractorPromise;
}

// Returns a normalized embedding as a plain array of numbers.
export async function embed(text) {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

export function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}
