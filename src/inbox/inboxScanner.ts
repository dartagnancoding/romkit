/**
 * Turns the files in the inbox folder into a list of items to process.
 *
 * - A .cue and the tracks it references are one item (the cue).
 * - A multi-part RAR ("game.part01.rar", "game.part02.rar"... or "game.rar",
 *   "game.r00", "game.r01"...) is one item: the first volume. 7-Zip reads the
 *   other parts by itself.
 * - Helper files (.bat, desktop.ini...) are ignored entirely.
 */

import { basename, dirname, join, resolve } from "node:path";
import { parseCueFileReferences, readCueSheet } from "../extraction/cueSheet";
import { fileStem, listFilesRecursive, lowercaseExtension } from "../util/fileSystem";

export interface InboxItem {
  /** The file to process (a ROM, an archive's first volume, or a .cue). */
  filePath: string;
  /** Other files that belong to it and must leave the inbox with it (RAR parts). */
  companionPaths: string[];
}

export interface InboxScan {
  items: InboxItem[];
  /** Files that are neither items nor part of one (readmes, .url, save files...). */
  looseFiles: string[];
}

/** Files that live in the inbox but are never ROMs: the launcher script, Windows metadata. */
const IGNORED_FILE_PATTERN = /\.(bat|cmd|ps1|lnk)$|^desktop\.ini$|^thumbs\.db$/i;
/** Files that are never a game by themselves. */
const NON_GAME_FILE_PATTERN = /\.(txt|nfo|url|htm|html|sfv|md5|jpg|jpeg|png|gif|pdf|diz|srm|sav|state|db)$/i;

/** "game.part02.rar" → part 2 */
const NUMBERED_PART_PATTERN = /\.part(\d+)\.rar$/i;
/** "game.r00", "game.r01"... (old-style RAR volumes after "game.rar") */
const OLD_STYLE_VOLUME_PATTERN = /\.r\d{2,3}$/i;

export async function scanInbox(inboxRoot: string): Promise<InboxScan> {
  const allFiles = (await listFilesRecursive(inboxRoot)).filter((filePath) => !IGNORED_FILE_PATTERN.test(basename(filePath)));
  const claimedLowerPaths = new Set<string>();
  const items: InboxItem[] = [];

  // Cue sheets claim their tracks.
  for (const cuePath of allFiles.filter((filePath) => lowercaseExtension(filePath) === ".cue")) {
    for (const reference of parseCueFileReferences(await readCueSheet(cuePath))) {
      claimedLowerPaths.add(resolve(dirname(cuePath), reference).toLowerCase());
    }
  }

  // Multi-part RAR: keep only the first volume as the item; the others are companions.
  const lowerPathSet = new Set(allFiles.map((filePath) => resolve(filePath).toLowerCase()));
  const companionsByFirstVolume = new Map<string, string[]>();
  for (const filePath of allFiles) {
    const numberedPart = NUMBERED_PART_PATTERN.exec(filePath);
    if (numberedPart && Number(numberedPart[1]) > 1) {
      const firstVolume = filePath.replace(NUMBERED_PART_PATTERN, (match) => match.replace(/\d+/, (digits) => "1".padStart(digits.length, "0")));
      addCompanion(companionsByFirstVolume, firstVolume, filePath, claimedLowerPaths);
      continue;
    }
    if (OLD_STYLE_VOLUME_PATTERN.test(filePath)) {
      const firstVolume = join(dirname(filePath), `${fileStem(filePath)}.rar`);
      if (lowerPathSet.has(resolve(firstVolume).toLowerCase())) {
        addCompanion(companionsByFirstVolume, firstVolume, filePath, claimedLowerPaths);
      }
    }
  }

  const looseFiles: string[] = [];
  for (const filePath of allFiles) {
    if (claimedLowerPaths.has(resolve(filePath).toLowerCase())) continue;
    if (NON_GAME_FILE_PATTERN.test(filePath)) {
      looseFiles.push(filePath);
      continue;
    }
    items.push({ filePath, companionPaths: companionsByFirstVolume.get(resolve(filePath).toLowerCase()) ?? [] });
  }
  items.sort((first, second) => first.filePath.localeCompare(second.filePath));
  return { items, looseFiles };
}

function addCompanion(companionsByFirstVolume: Map<string, string[]>, firstVolume: string, companionPath: string, claimedLowerPaths: Set<string>): void {
  const key = resolve(firstVolume).toLowerCase();
  companionsByFirstVolume.set(key, [...(companionsByFirstVolume.get(key) ?? []), companionPath]);
  claimedLowerPaths.add(resolve(companionPath).toLowerCase());
}
