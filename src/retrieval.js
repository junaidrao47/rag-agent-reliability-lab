import { getDb } from "./db.js";
import { embed, cosineSimilarity } from "./embeddings.js";
import { getFlags } from "./config.js";

// Which policy versions are eligible for retrieval.
function policyFilter() {
  return getFlags().STALE_DOC ? {} : { isCurrent: true };
}

// Keeps one version of each policy so the model never sees two versions of
// the same document. With STALE_DOC on, the comparator is the wrong way round
// and the oldest version wins.
function onePerTitle(docs) {
  const newestFirst = (a, b) => b.effectiveDate.localeCompare(a.effectiveDate);
  const oldestFirst = (a, b) => a.effectiveDate.localeCompare(b.effectiveDate);
  const byTitle = new Map();
  const ordered = [...docs].sort(getFlags().STALE_DOC ? oldestFirst : newestFirst);
  for (const doc of ordered) {
    if (!byTitle.has(doc.title)) byTitle.set(doc.title, doc);
  }
  return docs.filter((doc) => byTitle.get(doc.title) === doc);
}

/**
 * Returns the k policies most similar to the query, best first.
 * Only isCurrent: true docs are considered, one per title.
 * Only ~10 docs, so similarity is computed in Node (no vector index).
 */
export async function retrievePolicies(query, k = 3) {
  const db = await getDb();
  const [queryEmbedding, docs] = await Promise.all([
    embed(query),
    db.collection("policies").find(policyFilter()).toArray(),
  ]);

  return onePerTitle(docs)
    .map(({ embedding, _id, ...policy }) => ({
      ...policy,
      score: Number(cosineSimilarity(queryEmbedding, embedding).toFixed(4)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
