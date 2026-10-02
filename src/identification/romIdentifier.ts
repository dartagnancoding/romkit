/**
 * Decides which game a ROM unit is, and how sure we are.
 *
 * Strategies, in order:
 *   1. hash     CRC32/SHA1 found in the system's DAT              → confidence 1.00
 *   2. alias    a hint matches the alias table (MMZ4 → ...)        → confidence 0.95
 *   3. fuzzy    a hint resembles a DAT title                       → confidence = similarity
 *   4. filename no DAT match: clean up the best hint               → see filenameConfidence()
 *
 * "Hints" are names that may describe the game: the ROM file name, the search
 * result title, the archive name, the search query...
 *
 * The caller compares the confidence with matching.autoAcceptThreshold and asks
 * the user to confirm when it is lower.
 */

import type { ResolvedConfig, ResolvedSystem } from "../config/configTypes";
import type { RomUnit } from "../extraction/romUnits";
import { logger } from "../logging/logger";
import { parseRomName, type ParsedRomName, type RomTag } from "../naming/tagParser";
import { normalizeTitleForComparison } from "../naming/titleNormalization";
import { fileStem, pathExists } from "../util/fileSystem";
import { AliasTable } from "./aliasTable";
import { loadDatIndex, type DatIndex, type DatTitleEntry } from "./datIndex";
import { hashFile } from "./fileHasher";
import { rankBySimilarity } from "./fuzzyMatcher";

export type IdentificationMethod = "hash" | "alias" | "fuzzy" | "filename";

export interface IdentificationCandidate {
  title: string;
  tags: RomTag[];
  /** 0..1 */
  confidence: number;
}

export interface IdentificationResult extends IdentificationCandidate {
  method: IdentificationMethod;
  /** Short human explanation, e.g. 'CRC32 3a4b5c6d matched "Game (USA)" in the DAT'. */
  explanation: string;
  /** Other plausible titles, offered when the user is asked to confirm. */
  alternatives: IdentificationCandidate[];
}

export interface IdentificationContext {
  system: ResolvedSystem;
  aliasTable: AliasTable;
  datIndex: DatIndex | null;
}

const ALIAS_CONFIDENCE = 0.95;
/** Below this similarity a DAT title is not even offered as a suggestion. */
const MINIMUM_FUZZY_SCORE = 0.45;
const MAX_ALTERNATIVES = 5;

/** Loads the alias table and the system's DAT (if configured and present). */
export async function loadIdentificationContext(system: ResolvedSystem, config: ResolvedConfig): Promise<IdentificationContext> {
  const aliasTable = await AliasTable.load(config.aliasesFilePath);
  let datIndex: DatIndex | null = null;
  if (system.datPath) {
    if (await pathExists(system.datPath)) {
      datIndex = await loadDatIndex(system.datPath);
    } else {
      logger.warn(`DAT file for ${system.id} not found at ${system.datPath}; identifying by name only.`);
    }
  }
  return { system, aliasTable, datIndex };
}

export async function identifyRomUnit(unit: RomUnit, extraHints: string[], context: IdentificationContext): Promise<IdentificationResult> {
  const { datIndex } = context;

  // 1. Hash lookup. For a cue sheet the first track (the data track) is hashed,
  //    since the .cue itself changes whenever files are renamed.
  if (datIndex) {
    const fileToHash = unit.kind === "cue-sheet" ? (unit.cueReferences[0]?.filePath ?? unit.primaryFilePath) : unit.primaryFilePath;
    const hashes = await hashFile(fileToHash);
    logger.debug(`CRC32 ${hashes.crc32}  SHA1 ${hashes.sha1}  (${fileToHash})`);
    const datGame = datIndex.findByHashes(hashes);
    if (datGame) {
      const canonical = parseRomName(datGame.name);
      return {
        ...canonical,
        method: "hash",
        confidence: 1,
        explanation: `checksum matched "${datGame.name}" in the DAT`,
        alternatives: [],
      };
    }
    logger.debug("No checksum match in the DAT.");
  }

  const hints = buildHints(unit, extraHints);

  // 2. Alias table.
  for (const hint of hints) {
    const aliasTitle = context.aliasTable.lookup(context.system.id, hint.title);
    if (!aliasTitle) continue;
    // If the DAT knows this title, use the DAT's exact spelling.
    const datEntry = datIndex?.findTitle(normalizeTitleForComparison(aliasTitle));
    return {
      title: datEntry?.title ?? aliasTitle,
      tags: hint.tags,
      method: "alias",
      confidence: ALIAS_CONFIDENCE,
      explanation: `alias "${hint.title}" → "${aliasTitle}"`,
      alternatives: [],
    };
  }

  // 3. Fuzzy match against DAT titles.
  if (datIndex) {
    const fuzzyResult = fuzzyMatchAgainstDat(hints, datIndex);
    if (fuzzyResult) return fuzzyResult;
  }

  // 4. Fall back to cleaning up the most promising hint.
  return identifyFromFileName(hints, datIndex !== null);
}

/** Turns raw hints into parsed names, most specific first, without duplicates. */
function buildHints(unit: RomUnit, extraHints: string[]): ParsedRomName[] {
  const rawHints = [fileStem(unit.primaryFilePath), ...extraHints];
  const seenKeys = new Set<string>();
  const hints: ParsedRomName[] = [];
  for (const rawHint of rawHints) {
    let parsedHint = parseRomName(rawHint);
    // "mega_man_zero_4" → "mega man zero 4"
    if (!parsedHint.title.includes(" ") && /[_.]/.test(parsedHint.title)) {
      parsedHint = { ...parsedHint, title: parsedHint.title.replace(/[_.]+/g, " ").trim() };
    }
    const key = normalizeTitleForComparison(parsedHint.title);
    if (key === "" || seenKeys.has(key)) continue;
    seenKeys.add(key);
    hints.push(parsedHint);
  }
  return hints;
}

function fuzzyMatchAgainstDat(hints: ParsedRomName[], datIndex: DatIndex): IdentificationResult | null {
  const candidates = datIndex.titleEntries.map((entry) => ({ normalizedTitle: entry.normalizedTitle, value: entry }));

  // Rank DAT titles against every hint and keep each title's best score.
  const bestByEntry = new Map<DatTitleEntry, { score: number; hint: ParsedRomName }>();
  for (const hint of hints) {
    const ranked = rankBySimilarity(normalizeTitleForComparison(hint.title), candidates, MAX_ALTERNATIVES + 1);
    for (const rankedCandidate of ranked) {
      const previousBest = bestByEntry.get(rankedCandidate.value);
      if (!previousBest || rankedCandidate.score > previousBest.score) {
        bestByEntry.set(rankedCandidate.value, { score: rankedCandidate.score, hint });
      }
    }
  }

  const ordered = [...bestByEntry.entries()]
    .map(([entry, match]) => ({ entry, ...match }))
    .sort((first, second) => second.score - first.score);
  const best = ordered[0];
  if (!best || best.score < MINIMUM_FUZZY_SCORE) return null;

  // The DAT tells the title, but not which regional version this file is,
  // so the tags come from the hint (e.g. the original file name).
  return {
    title: best.entry.title,
    tags: best.hint.tags,
    method: "fuzzy",
    confidence: best.score,
    explanation: `"${best.hint.title}" resembles "${best.entry.title}" in the DAT`,
    alternatives: ordered
      .slice(1, MAX_ALTERNATIVES + 1)
      .filter((alternative) => alternative.score >= MINIMUM_FUZZY_SCORE)
      .map((alternative) => ({ title: alternative.entry.title, tags: alternative.hint.tags, confidence: alternative.score })),
  };
}

function identifyFromFileName(hints: ParsedRomName[], datWasAvailable: boolean): IdentificationResult {
  // Prefer hints that look like release names ("Title (USA)") over short nicknames.
  // On a tie, prefer the one with more words: "007 - Goldeneye" (the archive name)
  // beats "GE00" (a cryptic file name inside it).
  const wordCount = (hint: ParsedRomName) => hint.title.split(/\s+/).filter(Boolean).length;
  const rankedHints = [...hints].sort(
    (first, second) =>
      filenameConfidence(second, datWasAvailable) - filenameConfidence(first, datWasAvailable) || wordCount(second) - wordCount(first),
  );
  const bestHint = rankedHints[0] ?? { title: "Unknown", tags: [] };
  return {
    title: bestHint.title,
    tags: bestHint.tags,
    method: "filename",
    confidence: filenameConfidence(bestHint, datWasAvailable),
    explanation: datWasAvailable ? "not found in the DAT; name taken from the file" : "no DAT configured; name taken from the file",
    alternatives: rankedHints.slice(1, MAX_ALTERNATIVES + 1).map((hint) => ({
      title: hint.title,
      tags: hint.tags,
      confidence: filenameConfidence(hint, datWasAvailable),
    })),
  };
}

/**
 * How much to trust a name taken straight from a file:
 * - a DAT exists but did not recognize it → low (0.4): probably a hack, a typo or a nickname;
 * - no DAT, and the name has release tags like "(USA)" → high (0.9): it is a
 *   proper release name, we only strip tags;
 * - otherwise → medium (0.6): it could be a nickname such as "mmz4".
 */
function filenameConfidence(hint: ParsedRomName, datWasAvailable: boolean): number {
  if (datWasAvailable) return 0.4;
  const hasReleaseTags = hint.tags.some((tag) => tag.bracket === "round");
  return hasReleaseTags ? 0.9 : 0.6;
}
