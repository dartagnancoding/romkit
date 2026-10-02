/**
 * Normalization used only for COMPARING titles (DAT lookup, fuzzy match, alias keys,
 * system lookup). It is never used to build the final file name.
 */

import { parseRomName } from "./tagParser";

/**
 * "Legend of Zelda, The - Minish Cap (Europe)" → "the legend of zelda minish cap"
 * "Pokémon Ruby & Sapphire"                     → "pokemon ruby and sapphire"
 */
export function normalizeTitleForComparison(rawTitle: string): string {
  const { title } = parseRomName(rawTitle);

  // NFD splits "é" into "e" + combining accent; the second replace drops the accent.
  let text = title.normalize("NFD").replace(/[̀-ͯ]/g, "");
  text = text.toLowerCase();

  // Some file names use underscores or dots instead of spaces ("mega_man_zero").
  text = text.replace(/[_.]+/g, " ");

  // No-Intro moves articles to the end: "Legend of Zelda, The - ..." → "the legend of zelda - ...".
  text = text.replace(/^(.*?),\s*(the|a|an)(?=\s*(?:-|$))/, "$2 $1");

  text = text.replace(/&/g, " and ").replace(/['’`]/g, "");
  text = text.replace(/[^a-z0-9]+/g, " ");
  return text.trim().replace(/\s+/g, " ");
}

/** Normalized and without spaces: "Game Boy Advance" and "gameboy advance" → "gameboyadvance". */
export function compactKey(text: string): string {
  return normalizeTitleForComparison(text).replace(/ /g, "");
}
