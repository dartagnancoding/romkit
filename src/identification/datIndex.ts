/**
 * Loads No-Intro / Redump DAT files (Logiqx XML format) and indexes them for
 * lookup by hash and by normalized title.
 *
 * Expected structure:
 *   <datafile>
 *     <header>...</header>
 *     <game name="Mega Man Zero 4 (Europe)">
 *       <rom name="Mega Man Zero 4 (Europe).gba" size="16777216" crc="..." sha1="..."/>
 *     </game>
 *   </datafile>
 */

import { readFile } from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";
import { RomkitError } from "../errors";
import { logger } from "../logging/logger";
import { parseRomName } from "../naming/tagParser";
import { normalizeTitleForComparison } from "../naming/titleNormalization";
import type { FileHashes } from "./fileHasher";

export interface DatRom {
  name: string;
  size: number | null;
  crc32: string | null;
  sha1: string | null;
}

export interface DatGame {
  /** Full canonical name with tags, e.g. "Mega Man Zero 4 (Europe)". */
  name: string;
  roms: DatRom[];
}

/** All DAT games sharing the same title (usually the regional versions of a game). */
export interface DatTitleEntry {
  /** Title without tags, as written in the DAT, e.g. "Mega Man Zero 4". */
  title: string;
  normalizedTitle: string;
  games: DatGame[];
}

export class DatIndex {
  private readonly gameBySha1 = new Map<string, DatGame>();
  private readonly gamesByCrc32 = new Map<string, DatGame[]>();
  private readonly titleEntryByNormalizedTitle = new Map<string, DatTitleEntry>();

  constructor(readonly games: DatGame[]) {
    for (const game of games) {
      for (const rom of game.roms) {
        if (rom.sha1) this.gameBySha1.set(rom.sha1, game);
        if (rom.crc32) {
          const gamesWithCrc = this.gamesByCrc32.get(rom.crc32) ?? [];
          gamesWithCrc.push(game);
          this.gamesByCrc32.set(rom.crc32, gamesWithCrc);
        }
      }

      const { title } = parseRomName(game.name);
      const normalizedTitle = normalizeTitleForComparison(title);
      const titleEntry = this.titleEntryByNormalizedTitle.get(normalizedTitle);
      if (titleEntry) {
        titleEntry.games.push(game);
      } else {
        this.titleEntryByNormalizedTitle.set(normalizedTitle, { title, normalizedTitle, games: [game] });
      }
    }
  }

  get titleEntries(): DatTitleEntry[] {
    return [...this.titleEntryByNormalizedTitle.values()];
  }

  /** SHA1 is checked first (practically collision-free); CRC32 + size is the fallback. */
  findByHashes(hashes: FileHashes): DatGame | null {
    const gameBySha1 = this.gameBySha1.get(hashes.sha1);
    if (gameBySha1) return gameBySha1;

    const crcCandidates = this.gamesByCrc32.get(hashes.crc32) ?? [];
    return (
      crcCandidates.find((game) =>
        game.roms.some((rom) => rom.crc32 === hashes.crc32 && (rom.size === null || rom.size === hashes.size)),
      ) ?? null
    );
  }

  findTitle(normalizedTitle: string): DatTitleEntry | null {
    return this.titleEntryByNormalizedTitle.get(normalizedTitle) ?? null;
  }
}

/** DATs are big; keep each parsed one for the rest of the run. */
const datIndexCache = new Map<string, Promise<DatIndex>>();

export function loadDatIndex(datPath: string): Promise<DatIndex> {
  let cachedIndex = datIndexCache.get(datPath);
  if (!cachedIndex) {
    cachedIndex = parseDatFile(datPath).then((games) => new DatIndex(games));
    datIndexCache.set(datPath, cachedIndex);
  }
  return cachedIndex;
}

async function parseDatFile(datPath: string): Promise<DatGame[]> {
  logger.debug(`Loading DAT ${datPath}`);
  const xmlText = await readFile(datPath, "utf8");

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    // Force arrays even when there is a single <game> or <rom>, so the code below
    // does not need to handle "object or array".
    isArray: (tagName) => tagName === "game" || tagName === "machine" || tagName === "rom",
  });

  let document: Record<string, unknown>;
  try {
    document = parser.parse(xmlText) as Record<string, unknown>;
  } catch (error) {
    throw new RomkitError(`Could not read DAT ${datPath}: ${(error as Error).message}`);
  }

  const datafile = document.datafile as Record<string, unknown> | undefined;
  if (!datafile) {
    throw new RomkitError(
      `${datPath} is not a Logiqx XML DAT (no <datafile> element).`,
      'Download the DAT in "XML" format from No-Intro (DAT-o-MATIC) or Redump.',
    );
  }

  // Some DATs (MAME-style) use <machine> instead of <game>.
  const rawGames = (datafile.game ?? datafile.machine ?? []) as Record<string, unknown>[];
  const games = rawGames.map((rawGame) => ({
    name: String(rawGame.name ?? ""),
    roms: ((rawGame.rom ?? []) as Record<string, unknown>[]).map(
      (rawRom): DatRom => ({
        name: String(rawRom.name ?? ""),
        size: rawRom.size !== undefined ? Number(rawRom.size) : null,
        crc32: rawRom.crc ? String(rawRom.crc).toLowerCase().padStart(8, "0") : null,
        sha1: rawRom.sha1 ? String(rawRom.sha1).toLowerCase() : null,
      }),
    ),
  }));
  logger.debug(`DAT loaded: ${games.length} entries`);
  return games.filter((game) => game.name !== "");
}
