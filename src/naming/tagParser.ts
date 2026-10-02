/**
 * Splits ROM names into a title and its tags.
 *
 *   "Mega Man Zero 4 (Europe) (En,Ja) [T-Por]"
 *     → title "Mega Man Zero 4", tags ["Europe", "En,Ja", "T-Por"]
 *
 * Works for No-Intro/Redump names ("(USA) (Rev 1)") and older GoodTools names ("(U) [!]").
 */

export interface RomTag {
  /** Text inside the brackets, e.g. "Rev 1". */
  text: string;
  bracket: "round" | "square";
}

export interface ParsedRomName {
  title: string;
  tags: RomTag[];
}

/** One (...) or [...] group at the very end of the string, with surrounding spaces. */
const TRAILING_TAG_PATTERN = /\s*(?:\(([^()]*)\)|\[([^[\]]*)\])\s*$/;

export function parseRomName(name: string): ParsedRomName {
  let remainingText = name.trim();
  const tags: RomTag[] = [];

  // Tags are peeled off from the END one at a time. This keeps parentheses that
  // belong to the title, e.g. "Title (Part 1) - Subtitle (USA)" only loses "(USA)",
  // because after it the string no longer ends with a bracket group.
  while (true) {
    const match = TRAILING_TAG_PATTERN.exec(remainingText);
    // match.index === 0 means the whole remaining text is a single tag ("(USA)"); keep it as the title.
    if (!match || match.index === 0) break;

    const roundContent = match[1];
    const squareContent = match[2];
    const tag: RomTag =
      roundContent !== undefined
        ? { text: roundContent.trim(), bracket: "round" }
        : { text: (squareContent ?? "").trim(), bracket: "square" };
    if (tag.text !== "") tags.unshift(tag);

    remainingText = remainingText.slice(0, match.index).trimEnd();
  }

  return { title: remainingText, tags };
}

export function renderTag(tag: RomTag): string {
  return tag.bracket === "round" ? `(${tag.text})` : `[${tag.text}]`;
}

/** Full region names (No-Intro) and single-letter GoodTools codes. Lowercase for comparison. */
const REGION_NAMES = new Set([
  "usa", "europe", "japan", "world", "brazil", "korea", "china", "asia", "australia",
  "france", "germany", "spain", "italy", "netherlands", "sweden", "canada", "taiwan",
  "hong kong", "russia", "uk", "scandinavia", "latin america", "portugal", "greece",
  "u", "e", "j", "w", "b", "k", "ue", "ju", "jue",
]);

/** True for tags such as "USA", "Europe" or "USA, Europe". */
export function isRegionTag(tag: RomTag): boolean {
  if (tag.bracket !== "round") return false;
  const parts = tag.text.split(",").map((part) => part.trim().toLowerCase());
  return parts.length > 0 && parts.every((part) => REGION_NAMES.has(part));
}
