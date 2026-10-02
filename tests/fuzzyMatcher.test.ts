import { describe, expect, test } from "bun:test";
import { titleSimilarity } from "../src/identification/fuzzyMatcher";
import { normalizeTitleForComparison } from "../src/naming/titleNormalization";

const similarity = (first: string, second: string) =>
  titleSimilarity(normalizeTitleForComparison(first), normalizeTitleForComparison(second));

describe("titleSimilarity", () => {
  test("identical titles after normalization score 1", () => {
    expect(similarity("Legend of Zelda, The - The Minish Cap (Europe)", "the legend of zelda the minish cap")).toBe(1);
  });

  test("small spelling differences still score high", () => {
    expect(similarity("Megaman Zero 4", "Mega Man Zero 4")).toBeGreaterThan(0.6);
  });

  test("different sequel numbers are penalized", () => {
    expect(similarity("Mega Man Zero 3", "Mega Man Zero 4")).toBeLessThan(similarity("Megaman Zero 4", "Mega Man Zero 4"));
    expect(similarity("Mega Man Zero 3", "Mega Man Zero 4")).toBeLessThan(0.6);
  });

  test("unrelated titles score low", () => {
    expect(similarity("Golden Sun", "Mega Man Zero 4")).toBeLessThan(0.3);
  });
});
