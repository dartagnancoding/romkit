/**
 * Decides which of two releases of the same game is "better" for the library
 * ("1G1R": one game, one ROM), from their tags.
 *
 * Criteria, in order:
 *   1. bad dumps, hacks, overdumps, pirate copies lose against clean dumps;
 *   2. prototypes, betas and demos lose against final releases;
 *   3. fan translations: avoided or preferred, depending on the setting;
 *   4. region, by the configured order (e.g. USA > World > Europe > Japan);
 *   5. "[!]" (verified good dump, GoodTools) wins;
 *   6. higher revision wins ("Rev 2" over "Rev 1" over none).
 *
 * Tags are those of the ORIGINAL release name ("Game (Europe) (Rev 1)"),
 * which romkit keeps in the library index since the final file names drop them.
 */

import type { ReleasePreferences } from "../config/configTypes";
import { isRegionTag, type RomTag } from "./tagParser";

/** GoodTools single-letter region codes → No-Intro region names. */
const REGION_CODE_NAMES: Record<string, string[]> = {
  u: ["usa"],
  e: ["europe"],
  j: ["japan"],
  w: ["world"],
  b: ["brazil"],
  k: ["korea"],
  ue: ["usa", "europe"],
  ju: ["japan", "usa"],
  jue: ["japan", "usa", "europe"],
};

/**
 * Fan translations into Portuguese and similar markers: "[T-Por]", "[T+Por by X]",
 * "[T-BR]", "(BR)", "(PT-BR)", "[Pt-br]". Note "(Brazil)" is NOT here: it is an
 * official region (e.g. Tec Toy releases).
 */
const TRANSLATION_PATTERN = /^(t[-+]\w+|pt-?br|br|translated|traducao|tradução)\b/i;
/** GoodTools flags for problematic dumps: [b] bad, [h] hack, [o] overdump, [p] pirate, [t] trainer, [f] fixed. */
const PROBLEM_DUMP_PATTERN = /^[bhopt]\d*(\s|$|[+\]])|^(hack|bad dump)\b/i;
/** Unfinished releases: "(Prototype)", "(Proto 2)", "(Beta)", "(Demo)", "(Sample)", "(Alpha)", "(Preview)". */
const PRERELEASE_PATTERN = /^(proto(type)?|beta|demo|sample|alpha|preview|pre-?release)\b/i;
const VERIFIED_DUMP_TAG = "!";
const REVISION_PATTERN = /^rev\s*([0-9a-z.]+)$/i;

export interface ReleaseTraits {
  isProblemDump: boolean;
  isPrerelease: boolean;
  isTranslation: boolean;
  /** Position in the preferred region list; lower is better; Infinity when unknown. */
  regionRank: number;
  isVerifiedDump: boolean;
  /** Numeric revision for comparison; 0 when there is none. */
  revision: number;
}

export function describeTraits(tags: RomTag[], preferences: ReleasePreferences): ReleaseTraits {
  const regionOrder = preferences.regionOrder.map((region) => region.toLowerCase());
  let regionRank = Number.POSITIVE_INFINITY;
  let revision = 0;
  let isTranslation = false;
  let isProblemDump = false;
  let isPrerelease = false;
  let isVerifiedDump = false;

  for (const tag of tags) {
    const text = tag.text.trim();
    if (text === VERIFIED_DUMP_TAG) isVerifiedDump = true;
    if (TRANSLATION_PATTERN.test(text)) isTranslation = true;
    if (tag.bracket === "square" && PROBLEM_DUMP_PATTERN.test(text)) isProblemDump = true;
    if (tag.bracket === "round" && PRERELEASE_PATTERN.test(text)) isPrerelease = true;

    const revisionMatch = REVISION_PATTERN.exec(text);
    if (revisionMatch) revision = revisionValue(revisionMatch[1]!);

    if (isRegionTag(tag)) {
      // "USA, Europe" counts as its best region.
      for (const part of text.split(",").map((piece) => piece.trim().toLowerCase())) {
        for (const regionName of REGION_CODE_NAMES[part] ?? [part]) {
          const rank = regionOrder.indexOf(regionName);
          if (rank !== -1) regionRank = Math.min(regionRank, rank);
        }
      }
    }
  }
  return { isProblemDump, isPrerelease, isTranslation, regionRank, isVerifiedDump, revision };
}

/** "1" → 1, "A" → 1, "B" → 2, "1.1" → 1.1 */
function revisionValue(text: string): number {
  const numeric = Number(text);
  if (!Number.isNaN(numeric)) return numeric;
  const firstLetter = text.toLowerCase().charCodeAt(0);
  return firstLetter >= 97 && firstLetter <= 122 ? firstLetter - 96 : 0;
}

/** One short reason why `winnerTags` beats `loserTags`, following the same order as compareReleases. */
export function explainPreference(winnerTags: RomTag[], loserTags: RomTag[], preferences: ReleasePreferences): string {
  const winner = describeTraits(winnerTags, preferences);
  const loser = describeTraits(loserTags, preferences);
  if (winner.isProblemDump !== loser.isProblemDump) return "clean dump over bad dump/hack";
  if (winner.isPrerelease !== loser.isPrerelease) return "final release over prototype/beta";
  if (preferences.translations !== "neutral" && winner.isTranslation !== loser.isTranslation) {
    return winner.isTranslation ? "translation preferred" : "original over translation";
  }
  if (winner.regionRank !== loser.regionRank) {
    const regionName = (rank: number) => (Number.isFinite(rank) ? preferences.regionOrder[rank] : "unknown region");
    return `${regionName(winner.regionRank)} over ${regionName(loser.regionRank)}`;
  }
  if (winner.isVerifiedDump !== loser.isVerifiedDump) return "verified dump [!]";
  if (winner.revision !== loser.revision) return "newer revision";
  return "same version; first one kept";
}

/**
 * > 0 when `candidate` is better than `existing`, < 0 when worse, 0 when the
 * tags give no reason to prefer either.
 */
export function compareReleases(candidateTags: RomTag[], existingTags: RomTag[], preferences: ReleasePreferences): number {
  const candidate = describeTraits(candidateTags, preferences);
  const existing = describeTraits(existingTags, preferences);

  if (candidate.isProblemDump !== existing.isProblemDump) return candidate.isProblemDump ? -1 : 1;
  if (candidate.isPrerelease !== existing.isPrerelease) return candidate.isPrerelease ? -1 : 1;

  if (preferences.translations !== "neutral" && candidate.isTranslation !== existing.isTranslation) {
    const translationWins = preferences.translations === "prefer";
    return candidate.isTranslation === translationWins ? 1 : -1;
  }

  if (candidate.regionRank !== existing.regionRank) return candidate.regionRank < existing.regionRank ? 1 : -1;
  if (candidate.isVerifiedDump !== existing.isVerifiedDump) return candidate.isVerifiedDump ? 1 : -1;
  if (candidate.revision !== existing.revision) return candidate.revision > existing.revision ? 1 : -1;
  return 0;
}
