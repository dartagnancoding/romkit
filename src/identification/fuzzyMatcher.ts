/**
 * Approximate title comparison. Inputs must already be normalized with
 * normalizeTitleForComparison (lowercase, no punctuation, single spaces).
 *
 * Score = 60% character-bigram similarity (tolerates typos and small spelling
 * differences) + 40% word overlap (tolerates reordered/missing words), then a
 * penalty when the numbers differ, because "mega man zero 3" and
 * "mega man zero 4" are almost identical letter by letter but are different games.
 */

/** Pairs of adjacent characters: "zero" → ze, er, ro. Spaces are ignored. */
function characterBigrams(text: string): Map<string, number> {
  const compactText = text.replace(/ /g, "");
  const bigramCounts = new Map<string, number>();
  for (let position = 0; position < compactText.length - 1; position++) {
    const bigram = compactText.slice(position, position + 2);
    bigramCounts.set(bigram, (bigramCounts.get(bigram) ?? 0) + 1);
  }
  return bigramCounts;
}

/** Sørensen–Dice coefficient over character bigrams: 1 = identical, 0 = nothing in common. */
export function diceCoefficient(firstText: string, secondText: string): number {
  const firstBigrams = characterBigrams(firstText);
  const secondBigrams = characterBigrams(secondText);
  let firstTotal = 0;
  let secondTotal = 0;
  let sharedCount = 0;
  for (const count of firstBigrams.values()) firstTotal += count;
  for (const count of secondBigrams.values()) secondTotal += count;
  for (const [bigram, count] of firstBigrams) {
    sharedCount += Math.min(count, secondBigrams.get(bigram) ?? 0);
  }
  if (firstTotal + secondTotal === 0) return firstText === secondText ? 1 : 0;
  return (2 * sharedCount) / (firstTotal + secondTotal);
}

/** Shared words / all distinct words (Jaccard index). */
function wordOverlap(firstText: string, secondText: string): number {
  const firstWords = new Set(firstText.split(" ").filter(Boolean));
  const secondWords = new Set(secondText.split(" ").filter(Boolean));
  const allWords = new Set([...firstWords, ...secondWords]);
  if (allWords.size === 0) return 0;
  let sharedWords = 0;
  for (const word of firstWords) if (secondWords.has(word)) sharedWords++;
  return sharedWords / allWords.size;
}

function numbersIn(text: string): string {
  return (text.match(/\d+/g) ?? []).join(",");
}

const NUMBER_MISMATCH_PENALTY = 0.6;

export function titleSimilarity(firstNormalized: string, secondNormalized: string): number {
  if (firstNormalized === secondNormalized) return 1;
  let score = 0.6 * diceCoefficient(firstNormalized, secondNormalized) + 0.4 * wordOverlap(firstNormalized, secondNormalized);
  if (numbersIn(firstNormalized) !== numbersIn(secondNormalized)) score *= NUMBER_MISMATCH_PENALTY;
  return score;
}

export interface RankedCandidate<Value> {
  value: Value;
  score: number;
}

export function rankBySimilarity<Value>(
  normalizedQuery: string,
  candidates: { normalizedTitle: string; value: Value }[],
  limit: number,
): RankedCandidate<Value>[] {
  return candidates
    .map((candidate) => ({ value: candidate.value, score: titleSimilarity(normalizedQuery, candidate.normalizedTitle) }))
    .sort((first, second) => second.score - first.score)
    .slice(0, limit);
}
